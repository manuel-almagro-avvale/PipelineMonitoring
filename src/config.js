// Lectura y validación de la configuración desde variables de entorno (SPEC apartado 2).

import { LEVELS } from './logger.js';

export class ConfigError extends Error {
  constructor(errors) {
    super(`Configuración inválida:\n- ${errors.join('\n- ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const SERVICE_KEY_FIELDS = ['clientid', 'clientsecret', 'tokenurl', 'url'];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Las service keys de Integration Suite traen las credenciales dentro de "oauth";
// también se acepta el formato plano con los campos en la raíz.
function parseServiceKey(name, raw, errors) {
  if (isBlank(raw)) {
    errors.push(`${name}: variable obligatoria no definida.`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // No se incluye el mensaje de JSON.parse: puede contener fragmentos del secreto.
    errors.push(`${name}: no es JSON válido.`);
    return null;
  }
  const creds = json && typeof json.oauth === 'object' && json.oauth !== null ? json.oauth : json;
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    errors.push(`${name}: el JSON no es un objeto.`);
    return null;
  }
  const missing = SERVICE_KEY_FIELDS.filter((f) => typeof creds[f] !== 'string' || creds[f].trim() === '');
  if (missing.length > 0) {
    errors.push(`${name}: faltan los campos ${missing.join(', ')}.`);
    return null;
  }
  for (const field of ['tokenurl', 'url']) {
    if (!parseUrl(creds[field])) {
      errors.push(`${name}: el campo ${field} no es una URL http(s) válida.`);
      return null;
    }
  }
  return {
    clientId: creds.clientid,
    clientSecret: creds.clientsecret,
    tokenUrl: creds.tokenurl,
    url: creds.url.replace(/\/+$/, ''),
  };
}

function parseRequiredString(name, raw, errors) {
  if (isBlank(raw)) {
    errors.push(`${name}: variable obligatoria no definida.`);
    return null;
  }
  return raw.trim();
}

function parseInteger(name, raw, { min, defaultValue }, errors) {
  if (isBlank(raw)) {
    if (defaultValue !== undefined) return defaultValue;
    errors.push(`${name}: variable obligatoria no definida.`);
    return null;
  }
  const str = String(raw).trim();
  const value = Number(str);
  if (!/^\d+$/.test(str) || !Number.isSafeInteger(value) || value < min) {
    errors.push(`${name}: debe ser un entero ${min === 0 ? '≥ 0' : `≥ ${min}`} (valor recibido: "${str}").`);
    return null;
  }
  return value;
}

function parseRatio(name, raw, defaultValue, errors) {
  if (isBlank(raw)) return defaultValue;
  const str = String(raw).trim();
  const value = Number(str);
  if (!/^\d+(\.\d+)?$/.test(str) || !(value > 0 && value <= 1)) {
    errors.push(`${name}: debe ser un decimal en (0, 1] (valor recibido: "${str}").`);
    return null;
  }
  return value;
}

function parseQueues(name, raw, errors) {
  if (raw === undefined || raw === null) {
    errors.push(`${name}: variable obligatoria no definida (puede estar vacía, pero debe existir).`);
    return null;
  }
  const queues = String(raw)
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);
  return [...new Set(queues)];
}

function parseLogLevel(name, raw, errors) {
  if (isBlank(raw)) return 'info';
  const level = raw.trim().toLowerCase();
  if (!(level in LEVELS)) {
    errors.push(`${name}: debe ser uno de ${Object.keys(LEVELS).join(', ')} (valor recibido: "${raw.trim()}").`);
    return null;
  }
  return level;
}

export function loadConfig(env) {
  const errors = [];

  const cpiKey = parseServiceKey('CPI_API_SERVICE_KEY', env.CPI_API_SERVICE_KEY, errors);
  const alertKey = parseServiceKey('ALERT_SERVICE_KEY', env.ALERT_SERVICE_KEY, errors);

  let alertEndpointPath = parseRequiredString('ALERT_ENDPOINT_PATH', env.ALERT_ENDPOINT_PATH, errors);
  if (alertEndpointPath !== null && !alertEndpointPath.startsWith('/')) {
    errors.push(`ALERT_ENDPOINT_PATH: debe empezar por "/" (valor recibido: "${alertEndpointPath}").`);
    alertEndpointPath = null;
  }

  const clientName = parseRequiredString('CLIENT_NAME', env.CLIENT_NAME, errors);
  const environment = parseRequiredString('ENVIRONMENT', env.ENVIRONMENT, errors);
  const monitoredQueues = parseQueues('MONITORED_QUEUES', env.MONITORED_QUEUES, errors);
  const freqMinutes = parseInteger('MONITORING_FREQ_IN_MINUTES', env.MONITORING_FREQ_IN_MINUTES, { min: 1 }, errors);
  const waitSeconds = parseInteger('MONITORING_WAIT_IN_SECONDS', env.MONITORING_WAIT_IN_SECONDS, { min: 1 }, errors);
  const minRatio = parseRatio('STUCK_MESSAGES_MIN_RATIO', env.STUCK_MESSAGES_MIN_RATIO, 1.0, errors);
  const sampleSize = parseInteger('STUCK_CHECK_SAMPLE_SIZE', env.STUCK_CHECK_SAMPLE_SIZE, { min: 1, defaultValue: 20 }, errors);
  const reminderMinutes = parseInteger('ALERT_REMINDER_IN_MINUTES', env.ALERT_REMINDER_IN_MINUTES, { min: 0, defaultValue: 0 }, errors);
  const logLevel = parseLogLevel('LOG_LEVEL', env.LOG_LEVEL, errors);
  const port = parseInteger('PORT', env.PORT, { min: 1, defaultValue: 8080 }, errors);

  if (freqMinutes !== null && waitSeconds !== null && waitSeconds >= freqMinutes * 60) {
    errors.push(
      `Solapamiento: MONITORING_WAIT_IN_SECONDS (${waitSeconds} s) debe ser menor que ` +
        `MONITORING_FREQ_IN_MINUTES × 60 (${freqMinutes} min = ${freqMinutes * 60} s); ` +
        'si no, las iteraciones se pisarían.',
    );
  }

  if (errors.length > 0) throw new ConfigError(errors);

  return {
    cpiKey,
    alertKey,
    alertEndpointPath,
    alertUrl: alertKey.url + alertEndpointPath,
    clientName,
    environment,
    monitoredQueues,
    freqMinutes,
    waitSeconds,
    minRatio,
    sampleSize,
    reminderMinutes,
    logLevel,
    port,
  };
}

// Resumen de la configuración efectiva, sin secretos.
export function describeConfig(config) {
  const host = (url) => new URL(url).host;
  return [
    'Configuración cargada.',
    `Cliente: ${config.clientName}`,
    `Entorno: ${config.environment}`,
    `Colas: ${config.monitoredQueues.length > 0 ? config.monitoredQueues.join(', ') : '(ninguna)'}`,
    `Frecuencia: ${config.freqMinutes} min`,
    `Espera: ${config.waitSeconds} s`,
    `Ratio mínimo: ${config.minRatio}`,
    `Muestra: ${config.sampleSize} mensajes`,
    `Recordatorio: ${config.reminderMinutes > 0 ? `${config.reminderMinutes} min` : 'desactivado'}`,
    `Host API: ${host(config.cpiKey.url)} (token: ${host(config.cpiKey.tokenUrl)})`,
    `Host alertas: ${host(config.alertKey.url)} (token: ${host(config.alertKey.tokenUrl)}), ruta ${config.alertEndpointPath}`,
  ].join(' | ');
}
