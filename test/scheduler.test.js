import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isHealthy } from '../src/health.js';
import { DependencyError } from '../src/http.js';
import { Scheduler } from '../src/scheduler.js';
import { fakeLog } from './helpers.js';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  };
}

test('la siguiente iteración se programa desde el inicio de la anterior', async () => {
  let clock = 0;
  const t = fakeTimers();
  const log = fakeLog();
  const scheduler = new Scheduler({
    intervalMs: 300_000,
    task: async () => (clock += 70_000),
    log,
    now: () => clock,
    ...t,
  });
  scheduler.start();
  assert.equal(t.timers[0].ms, 0);
  await scheduler.tick();
  assert.equal(t.timers[1].ms, 230_000);
  assert.ok(log.has('info', 'Próxima iteración a las 00:05:00Z'));
});

test('si la iteración se alarga, la siguiente empieza inmediatamente con warning', async () => {
  let clock = 0;
  const t = fakeTimers();
  const log = fakeLog();
  const scheduler = new Scheduler({ intervalMs: 60_000, task: async () => (clock += 90_000), log, now: () => clock, ...t });
  await scheduler.tick();
  assert.equal(t.timers[0].ms, 0);
  assert.ok(log.has('warn', 'empieza inmediatamente'));
});

test('un error de dependencia no para el bucle y cuenta como iteración terminada', async () => {
  let clock = 1000;
  const t = fakeTimers();
  const log = fakeLog();
  const scheduler = new Scheduler({
    intervalMs: 60_000,
    task: async () => {
      throw new DependencyError('caído', { endpoint: '/x', status: 503 });
    },
    log,
    now: () => clock,
    ...t,
  });
  await scheduler.tick();
  assert.equal(scheduler.lastCompletedAt, 1000);
  assert.equal(t.timers.length, 1);
  assert.ok(log.has('error', 'caído [endpoint: /x, HTTP: 503]'));
});

test('un error inesperado se propaga (fatal)', async () => {
  const scheduler = new Scheduler({ intervalMs: 60_000, task: async () => { throw new TypeError('bug'); }, log: fakeLog(), ...fakeTimers() });
  await assert.rejects(scheduler.tick(), TypeError);
});

test('health check', () => {
  const limitMs = 2 * (5 * 60 + 60) * 1000;
  assert.equal(isHealthy({ startedAt: 0, lastCompletedAt: null, limitMs, now: limitMs - 1 }), true);
  assert.equal(isHealthy({ startedAt: 0, lastCompletedAt: null, limitMs, now: limitMs }), false);
  assert.equal(isHealthy({ startedAt: 0, lastCompletedAt: 10_000, limitMs, now: 10_000 + limitMs - 1 }), true);
  assert.equal(isHealthy({ startedAt: 0, lastCompletedAt: 10_000, limitMs, now: 10_000 + limitMs }), false);
});
