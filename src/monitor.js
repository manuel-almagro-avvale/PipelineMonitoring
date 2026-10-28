// Una iteración del ciclo de monitorización (SPEC apartados 5, 6 y 7).
// Todas las llamadas a la API ocurren antes de tocar el estado: si una falla (DependencyError),
// la excepción sale de aquí y el estado de deduplicación queda intacto.

import { log as defaultLog } from './logger.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// JMS Message ID de una fila de MessagingMessages. No se usa el Correlation ID.
export function messageId(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.jmsMessageId === 'string' && row.jmsMessageId !== '') return row.jmsMessageId;
  const key = Object.keys(row).find((k) => k.toLowerCase() === 'jmsmessageid');
  return key && typeof row[key] === 'string' && row[key] !== '' ? row[key] : null;
}

function messageIds(rows) {
  return [...new Set(rows.map(messageId).filter((id) => id !== null))];
}

function percent(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function formatCounts(reading) {
  if (reading.size === 0) return '(ninguna cola disponible)';
  return [...reading].map(([name, q]) => `${name}=${q.count}`).join(', ');
}

// Lee MessagingQueues y devuelve Map<queueName, { count, active }> solo con las colas monitorizadas válidas.
async function readQueues(cpi, monitoredQueues, log) {
  const rows = await cpi.listQueues();
  const byName = new Map(rows.map((row) => [row?.queueName, row]));
  const reading = new Map();
  for (const name of monitoredQueues) {
    const row = byName.get(name);
    if (!row) {
      log.warn(`Cola configurada no encontrada en el tenant: ${name}`);
      continue;
    }
    const count = parseCount(row.numberOfMessages);
    if (count === null) {
      log.warn(
        `Cola ${name}: numberOfMessages no es un entero válido (${JSON.stringify(row.numberOfMessages)}). ` +
          'Se excluye de esta iteración.',
      );
      continue;
    }
    reading.set(name, { count, active: row.active === true || row.active === 'true' });
  }
  return reading;
}

// Primera instantánea: muestra de hasta sampleSize JMS Message IDs.
async function takeSample(cpi, name, count, sampleSize, log) {
  const rows = await cpi.listMessages(name);
  if (rows.length < count) {
    log.debug(`Cola ${name}: la API devolvió ${rows.length} de ${count} mensajes (lista truncada).`);
  }
  const ids = messageIds(rows);
  if (rows.length > 0 && ids.length === 0) {
    log.warn(`Cola ${name}: ninguna de las ${rows.length} filas devueltas trae jmsMessageId.`);
  }
  return ids.slice(0, sampleSize);
}

// Segunda instantánea: cuántos IDs de la muestra siguen en la cola (SPEC apartado 5.3).
async function countPresent(cpi, name, sample, count, log) {
  const rows = await cpi.listMessages(name);
  const truncated = rows.length < count;
  if (truncated) {
    log.debug(
      `Cola ${name}: la API devolvió ${rows.length} de ${count} mensajes en la segunda lectura (lista truncada). ` +
        'Los IDs no encontrados se comprueban uno a uno.',
    );
  }
  const current = new Set(messageIds(rows));
  let present = 0;
  for (const id of sample) {
    if (current.has(id)) present++;
    else if (truncated && (await cpi.findMessage(name, id)).length > 0) present++;
  }
  return present;
}

export async function runIteration({ config, cpi, alerter, state, log = defaultLog, sleep = defaultSleep, now = () => Date.now() }) {
  const queues = config.monitoredQueues;
  if (queues.length === 0) {
    log.warn('MONITORED_QUEUES está vacía: no se monitoriza ninguna cola.');
    return;
  }
  log.info(`Iteración iniciada. Colas monitorizadas: ${queues.join(', ')}`);

  // Pasos 1–4: primera lectura de colas.
  const first = await readQueues(cpi, queues, log);
  const candidates = [...first].filter(([, q]) => q.count > 0).map(([name]) => name);

  // Paso 5: ninguna cola con mensajes. Se recuperan las colas en seguimiento que se han podido leer (vacías);
  // las que no aparecen o no se pudieron parsear no se pueden evaluar y su estado no cambia.
  if (candidates.length === 0) {
    log.info(`Primera lectura: ${formatCounts(first)}. Ninguna cola tiene mensajes.`);
    for (const name of state.trackedNames()) {
      if (first.has(name) && state.recover(name)) log.info(`Cola ${name} recuperada`);
    }
    return;
  }

  // Paso 6: primera instantánea de mensajes.
  const samples = new Map();
  for (const name of candidates) {
    samples.set(name, await takeSample(cpi, name, first.get(name).count, config.sampleSize, log));
  }

  // Paso 7: espera.
  log.info(`Primera lectura: ${formatCounts(first)}. Esperando ${config.waitSeconds} s para la segunda lectura.`);
  await sleep(config.waitSeconds * 1000);

  // Pasos 8–9: segunda lectura y evaluación (SPEC apartado 5.4).
  const second = await readQueues(cpi, queues, log);
  log.info(`Segunda lectura: ${formatCounts(second)}.`);

  const outcomes = new Map(); // queueName → { affected, previous, current, active }
  for (const name of queues) {
    const f = first.get(name);
    const s = second.get(name);
    if (!f || !s) continue; // no evaluable en esta iteración: el estado no cambia
    const base = { previous: f.count, current: s.count, active: s.active };

    if (f.count === 0) {
      outcomes.set(name, { ...base, affected: false });
      continue;
    }
    if (s.count < f.count) {
      log.info(`Cola ${name}: ${f.count} → ${s.count} mensajes, se está vaciando. Se descarta del análisis.`);
      outcomes.set(name, { ...base, affected: false });
      continue;
    }

    // Aquí s.count ≥ f.count > 0: se cumplen las condiciones 1 y 2.
    const sample = samples.get(name);
    if (sample.length === 0) {
      log.warn(`Cola ${name}: la muestra de mensajes está vacía; se evalúa solo por número de mensajes.`);
      log.warn(`Cola ${name} detenida: ${f.count} → ${s.count} mensajes (sin muestra de mensajes).`);
      outcomes.set(name, { ...base, affected: true });
      continue;
    }
    const present = await countPresent(cpi, name, sample, s.count, log);
    const ratio = present / sample.length;
    if (ratio >= config.minRatio) {
      log.warn(`Cola ${name} detenida: ${f.count} → ${s.count} mensajes, ${percent(ratio)} de los mensajes previos siguen en cola.`);
      outcomes.set(name, { ...base, affected: true });
    } else {
      log.info(
        `Cola ${name}: ${f.count} → ${s.count} mensajes, solo el ${percent(ratio)} de los mensajes previos siguen en cola ` +
          `(mínimo ${percent(config.minRatio)}). Se está procesando.`,
      );
      outcomes.set(name, { ...base, affected: false });
    }
  }

  // Paso 10: deduplicación (SPEC apartado 6).
  const detectedAt = now();
  const toNotify = [];
  for (const [name, outcome] of outcomes) {
    if (!outcome.affected) {
      if (state.recover(name)) log.info(`Cola ${name} recuperada`);
      continue;
    }
    const entry = state.track(name, detectedAt);
    if (state.shouldNotify(name, detectedAt, config.reminderMinutes)) {
      toNotify.push({ name, outcome, entry });
    } else {
      log.info(`Cola ${name} sigue detenida; ya se notificó a las ${new Date(entry.lastNotifiedAt).toISOString()}.`);
    }
  }

  // Paso 11: envío (SPEC apartado 7).
  if (toNotify.length === 0) return;

  const payload = {
    Client: config.clientName,
    Environment: config.environment,
    Timestamp: new Date(detectedAt).toISOString(),
    AffectedQueues: toNotify.map(({ name, outcome, entry }) => ({
      QueueName: name,
      PreviousQueuedMessages: outcome.previous,
      QueuedMessages: outcome.current,
      Active: outcome.active,
      FirstDetectedAt: new Date(entry.firstDetectedAt).toISOString(),
    })),
  };
  const names = toNotify.map((q) => q.name);
  const sent = await alerter.send(payload);
  if (sent) {
    for (const name of names) state.markNotified(name, now());
    log.info(`Alerta enviada correctamente (${names.length} ${names.length === 1 ? 'cola' : 'colas'}).`);
  } else {
    log.error(`No se pudo enviar la alerta tras todos los reintentos. Colas no notificadas: ${names.join(', ')}`);
  }
}
