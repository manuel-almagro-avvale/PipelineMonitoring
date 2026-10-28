import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlertState } from '../src/alertState.js';
import { DependencyError } from '../src/http.js';
import { runIteration } from '../src/monitor.js';
import { fakeLog } from './helpers.js';

const T0 = Date.parse('2026-10-28T09:15:00.000Z');

function config(overrides = {}) {
  return {
    clientName: 'VetClinic',
    environment: 'prod',
    monitoredQueues: ['Q1', 'Q2'],
    waitSeconds: 60,
    minRatio: 1.0,
    sampleSize: 20,
    reminderMinutes: 0,
    ...overrides,
  };
}

const ids = (...list) => list.map((id) => ({ jmsMessageId: id, correlationId: `corr-${id}` }));

// CPI falso. `phases[0]` es lo que hay en la primera lectura, `phases[1]` en la segunda (tras sleep).
// Cada fase: { queues: { Q: count|string }, messages: { Q: [ids] }, pageSize?: n }
function fakeCpi(phases, { failOn } = {}) {
  let phase = 0;
  const calls = [];
  const current = () => phases[Math.min(phase, phases.length - 1)];
  const maybeFail = (what) => {
    if (failOn === what) throw new DependencyError('fallo simulado', { endpoint: what, status: 500 });
  };
  return {
    calls,
    advance: () => phase++,
    async listQueues() {
      calls.push('listQueues');
      maybeFail(`listQueues#${phase}`);
      return Object.entries(current().queues).map(([queueName, n]) => ({
        queueName,
        numberOfMessages: String(n),
        active: true,
        exclusive: true,
      }));
    },
    async listMessages(q) {
      calls.push(`listMessages:${q}`);
      maybeFail(`listMessages#${phase}`);
      const all = ids(...(current().messages?.[q] ?? []));
      return current().pageSize ? all.slice(0, current().pageSize) : all;
    },
    async findMessage(q, id) {
      calls.push(`findMessage:${q}:${id}`);
      return ids(...(current().messages?.[q] ?? [])).filter((m) => m.jmsMessageId === id);
    },
  };
}

function harness(phases, { cfg = {}, sendResult = true, failOn, state = new AlertState(), clock = T0 } = {}) {
  const cpi = fakeCpi(phases, { failOn });
  const sent = [];
  const log = fakeLog();
  let now = clock;
  const ctx = {
    config: config(cfg),
    cpi,
    state,
    log,
    alerter: { send: async (p) => (sent.push(p), sendResult) },
    sleep: async (ms) => {
      assert.equal(ms, ctx.config.waitSeconds * 1000);
      cpi.advance();
    },
    now: () => now,
  };
  return { ctx, cpi, sent, log, state, run: () => runIteration(ctx), setNow: (t) => (now = t) };
}

test('cola detenida: notifica con el payload de la spec', async () => {
  const h = harness([
    { queues: { Q1: 3, Q2: 0 }, messages: { Q1: ['a', 'b', 'c'] } },
    { queues: { Q1: 4, Q2: 0 }, messages: { Q1: ['a', 'b', 'c', 'd'] } },
  ]);
  await h.run();
  assert.deepEqual(h.sent, [
    {
      Client: 'VetClinic',
      Environment: 'prod',
      Timestamp: '2026-10-28T09:15:00.000Z',
      AffectedQueues: [
        { QueueName: 'Q1', PreviousQueuedMessages: 3, QueuedMessages: 4, Active: true, FirstDetectedAt: '2026-10-28T09:15:00.000Z' },
      ],
    },
  ]);
  assert.ok(h.log.has('warn', 'Cola Q1 detenida: 3 → 4 mensajes, 100% de los mensajes previos siguen en cola.'));
  assert.ok(h.log.has('info', 'Alerta enviada correctamente (1 cola).'));
  assert.equal(h.state.get('Q1').lastNotifiedAt, T0);
});

test('cola que procesa mensajes (los antiguos salen) no se considera detenida', async () => {
  const h = harness([
    { queues: { Q1: 3 }, messages: { Q1: ['a', 'b', 'c'] } },
    { queues: { Q1: 5 }, messages: { Q1: ['c', 'd', 'e', 'f', 'g'] } },
  ]);
  await h.run();
  assert.equal(h.sent.length, 0);
  assert.ok(h.log.has('info', 'solo el 33.3%'));
});

test('el ratio configurable permite tolerar mensajes procesados', async () => {
  const h = harness(
    [
      { queues: { Q1: 4 }, messages: { Q1: ['a', 'b', 'c', 'd'] } },
      { queues: { Q1: 4 }, messages: { Q1: ['b', 'c', 'd', 'e'] } },
    ],
    { cfg: { minRatio: 0.75 } },
  );
  await h.run();
  assert.equal(h.sent.length, 1);
});

test('cola que baja se descarta; cola vacía no se consulta', async () => {
  const h = harness([
    { queues: { Q1: 5, Q2: 0 }, messages: { Q1: ['a', 'b', 'c', 'd', 'e'] } },
    { queues: { Q1: 4, Q2: 7 }, messages: { Q1: ['a', 'b', 'c', 'd'] } },
  ]);
  await h.run();
  assert.equal(h.sent.length, 0);
  assert.ok(h.log.has('info', 'Cola Q1: 5 → 4 mensajes, se está vaciando'));
  assert.ok(!h.cpi.calls.includes('listMessages:Q2'));
});

test('lista truncada: los IDs no devueltos se comprueban uno a uno', async () => {
  const h = harness(
    [
      { queues: { Q1: 6 }, messages: { Q1: ['a', 'b', 'c', 'd', 'e', 'f'] }, pageSize: 3 },
      { queues: { Q1: 8 }, messages: { Q1: ['x', 'y', 'a', 'b', 'c', 'z', 'w', 'v'] }, pageSize: 3 },
    ],
    { cfg: { monitoredQueues: ['Q1'], sampleSize: 3 } },
  );
  await h.run();
  // Muestra = a, b, c. En la 2.ª página solo aparece "a"; b y c se buscan individualmente y siguen ahí.
  assert.deepEqual(
    h.cpi.calls.filter((c) => c.startsWith('findMessage')),
    ['findMessage:Q1:b', 'findMessage:Q1:c'],
  );
  assert.equal(h.sent.length, 1);
});

test('lista no truncada: los IDs ausentes no se buscan', async () => {
  const h = harness(
    [
      { queues: { Q1: 2 }, messages: { Q1: ['a', 'b'] } },
      { queues: { Q1: 2 }, messages: { Q1: ['b', 'c'] } },
    ],
    { cfg: { monitoredQueues: ['Q1'] } },
  );
  await h.run();
  assert.ok(!h.cpi.calls.some((c) => c.startsWith('findMessage')));
  assert.equal(h.sent.length, 0);
});

test('muestra vacía: se evalúa solo por número de mensajes con warning', async () => {
  const h = harness(
    [
      { queues: { Q1: 2 }, messages: { Q1: [] } },
      { queues: { Q1: 2 }, messages: { Q1: ['a', 'b'] } },
    ],
    { cfg: { monitoredQueues: ['Q1'] } },
  );
  await h.run();
  assert.ok(h.log.has('warn', 'muestra de mensajes está vacía'));
  assert.equal(h.sent.length, 1);
});

test('colas no encontradas o con recuento no parseable generan warning', async () => {
  const h = harness([{ queues: { Q1: 'abc' } }], { cfg: { monitoredQueues: ['Q1', 'Q3'] } });
  await h.run();
  assert.ok(h.log.has('warn', 'Cola configurada no encontrada en el tenant: Q3'));
  assert.ok(h.log.has('warn', 'Cola Q1: numberOfMessages no es un entero válido'));
  assert.ok(h.log.has('info', 'Ninguna cola tiene mensajes'));
});

test('sin colas configuradas: warning y ninguna llamada', async () => {
  const h = harness([{ queues: {} }], { cfg: { monitoredQueues: [] } });
  await h.run();
  assert.equal(h.cpi.calls.length, 0);
  assert.ok(h.log.has('warn', 'MONITORED_QUEUES está vacía'));
});

const stuckPhases = () => [
  { queues: { Q1: 1 }, messages: { Q1: ['a'] } },
  { queues: { Q1: 1 }, messages: { Q1: ['a'] } },
];

test('deduplicación: solo se avisa una vez; recordatorio tras N minutos', async () => {
  const state = new AlertState();
  const once = harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'] } });
  await once.run();
  const again = harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'] }, clock: T0 + 30 * 60_000 });
  await again.run();
  assert.equal(once.sent.length + again.sent.length, 1);

  const reminderTooSoon = harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'], reminderMinutes: 60 }, clock: T0 + 59 * 60_000 });
  await reminderTooSoon.run();
  assert.equal(reminderTooSoon.sent.length, 0);

  const reminder = harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'], reminderMinutes: 60 }, clock: T0 + 60 * 60_000 });
  await reminder.run();
  assert.equal(reminder.sent.length, 1);
  assert.equal(reminder.sent[0].AffectedQueues[0].FirstDetectedAt, '2026-10-28T09:15:00.000Z');
});

test('recuperación: la cola sale del estado y se registra', async () => {
  const state = new AlertState();
  await harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'] } }).run();
  const h = harness([{ queues: { Q1: 0 } }], { state, cfg: { monitoredQueues: ['Q1'] } });
  await h.run();
  assert.ok(h.log.has('info', 'Cola Q1 recuperada'));
  assert.deepEqual(state.trackedNames(), []);
});

test('envío fallido: no se marca como notificada y se reintenta en la siguiente iteración', async () => {
  const state = new AlertState();
  const failed = harness(stuckPhases(), { state, sendResult: false, cfg: { monitoredQueues: ['Q1'] } });
  await failed.run();
  assert.ok(failed.log.has('error', 'Colas no notificadas: Q1'));
  assert.equal(state.get('Q1').lastNotifiedAt, null);

  const next = harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'] }, clock: T0 + 5 * 60_000 });
  await next.run();
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].AffectedQueues[0].FirstDetectedAt, '2026-10-28T09:15:00.000Z');
});

test('error de API a mitad de iteración: se propaga y el estado no cambia', async () => {
  const state = new AlertState();
  await harness(stuckPhases(), { state, cfg: { monitoredQueues: ['Q1'] } }).run();
  const before = { ...state.get('Q1') };

  const h = harness([{ queues: { Q1: 0 } }, { queues: { Q1: 0 } }], {
    state,
    failOn: 'listQueues#0',
    cfg: { monitoredQueues: ['Q1'] },
  });
  await assert.rejects(h.run(), DependencyError);
  assert.deepEqual(state.get('Q1'), before);
  assert.equal(h.sent.length, 0);
});
