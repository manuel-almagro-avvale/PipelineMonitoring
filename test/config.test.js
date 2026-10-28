import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { validEnv } from './helpers.js';

function errorsFor(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.errors;
  }
  assert.fail('se esperaba ConfigError');
}

test('carga una configuración válida con valores por defecto', () => {
  const config = loadConfig(validEnv());
  assert.deepEqual(config.monitoredQueues, ['Q1', 'Q2']);
  assert.equal(config.minRatio, 1.0);
  assert.equal(config.sampleSize, 20);
  assert.equal(config.reminderMinutes, 0);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.alertUrl, 'https://tenant-rt.example.com/http/pipeline/alert');
  assert.equal(config.cpiKey.clientId, 'sb-client!b1|it!b2');
});

test('acepta service keys en formato plano', () => {
  const flat = JSON.stringify({ clientid: 'a', clientsecret: 'b', url: 'https://x.com/', tokenurl: 'https://y.com/t' });
  const config = loadConfig(validEnv({ CPI_API_SERVICE_KEY: flat }));
  assert.equal(config.cpiKey.url, 'https://x.com');
});

test('MONITORED_QUEUES vacía no es un error', () => {
  assert.deepEqual(loadConfig(validEnv({ MONITORED_QUEUES: '' })).monitoredQueues, []);
});

test('MONITORED_QUEUES no definida sí es un error', () => {
  const env = validEnv();
  delete env.MONITORED_QUEUES;
  assert.match(errorsFor(env)[0], /^MONITORED_QUEUES/);
});

test('informa de cada variable que falla', () => {
  const errors = errorsFor(
    validEnv({ CLIENT_NAME: '', MONITORING_FREQ_IN_MINUTES: 'abc', STUCK_MESSAGES_MIN_RATIO: '1.5', LOG_LEVEL: 'trace' }),
  );
  assert.ok(errors.some((e) => e.startsWith('CLIENT_NAME')));
  assert.ok(errors.some((e) => e.startsWith('MONITORING_FREQ_IN_MINUTES')));
  assert.ok(errors.some((e) => e.startsWith('STUCK_MESSAGES_MIN_RATIO')));
  assert.ok(errors.some((e) => e.startsWith('LOG_LEVEL')));
});

test('service key no JSON o incompleta', () => {
  const [bad] = errorsFor(validEnv({ CPI_API_SERVICE_KEY: '{"clientsecret": "s3cr3t' }));
  assert.equal(bad, 'CPI_API_SERVICE_KEY: no es JSON válido.');
  assert.ok(!bad.includes('s3cr3t'));

  const [missing] = errorsFor(validEnv({ ALERT_SERVICE_KEY: JSON.stringify({ oauth: { clientid: 'a' } }) }));
  assert.match(missing, /ALERT_SERVICE_KEY: faltan los campos clientsecret, tokenurl, url/);
});

test('detecta el solapamiento entre espera y frecuencia', () => {
  const errors = errorsFor(validEnv({ MONITORING_FREQ_IN_MINUTES: '1', MONITORING_WAIT_IN_SECONDS: '60' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Solapamiento.*60 s.*1 min = 60 s.*pisarían/);
});

test('el resumen no contiene secretos', () => {
  const summary = describeConfig(loadConfig(validEnv()));
  assert.ok(!summary.includes('super-secret-value'));
  assert.ok(!summary.includes('sb-client'));
  assert.match(summary, /Host API: tenant\.example\.com/);
});
