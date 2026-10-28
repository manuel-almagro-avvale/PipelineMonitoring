// Punto de entrada: valida la configuración, arranca /health y el ciclo de monitorización.

import { AlertClient } from './alertClient.js';
import { AlertState } from './alertState.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { CpiClient } from './cpiClient.js';
import { createHealthServer, isHealthy } from './health.js';
import { log, registerSecret, setLevel } from './logger.js';
import { runIteration } from './monitor.js';
import { TokenCache } from './oauth.js';
import { Scheduler } from './scheduler.js';

// Errores fatales: se registran y el proceso termina con 1 para que CF lo reinicie (SPEC apartado 9.1).
process.on('uncaughtException', (err) => {
  log.error(`Error fatal no controlado: ${err?.stack ?? err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error(`Promesa rechazada sin controlar: ${reason?.stack ?? reason}`);
  process.exit(1);
});

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  for (const message of err.errors) log.error(`Configuración inválida: ${message}`);
  process.exit(1);
}

setLevel(config.logLevel);
registerSecret(config.cpiKey.clientSecret);
registerSecret(config.alertKey.clientSecret);

log.info(describeConfig(config));
if (config.monitoredQueues.length === 0) {
  log.warn('MONITORED_QUEUES está vacía: la app arranca pero no monitoriza ninguna cola.');
}

const cpi = new CpiClient({
  baseUrl: `${config.cpiKey.url}/api/v1`,
  tokenCache: new TokenCache({ ...config.cpiKey, label: 'API Integration Suite' }),
});
const alerter = new AlertClient({
  url: config.alertUrl,
  tokenCache: new TokenCache({ ...config.alertKey, label: 'endpoint de alertas' }),
});
const state = new AlertState();

const scheduler = new Scheduler({
  intervalMs: config.freqMinutes * 60_000,
  task: () => runIteration({ config, cpi, alerter, state }),
});

const healthLimitMs = 2 * (config.freqMinutes * 60 + config.waitSeconds) * 1000;
const server = createHealthServer(() =>
  isHealthy({
    startedAt: scheduler.startedAt,
    lastCompletedAt: scheduler.lastCompletedAt,
    limitMs: healthLimitMs,
    now: Date.now(),
  }),
);

server.listen(config.port, () => {
  log.info(`Health check escuchando en el puerto ${config.port} (/health).`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info(`Señal ${signal} recibida. Parando la aplicación.`);
    scheduler.stop();
    server.close();
    process.exit(0);
  });
}

scheduler.start();
