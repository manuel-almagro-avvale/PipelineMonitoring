// Planificación con setTimeout encadenado (SPEC apartado 5.1): nunca hay dos iteraciones a la vez.
// La siguiente se programa intervalMs después del INICIO de la anterior.

import { DependencyError } from './http.js';
import { log as defaultLog } from './logger.js';

function hhmmss(ms) {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

export class Scheduler {
  #timer = null;
  #stopped = false;

  constructor({ intervalMs, task, log = defaultLog, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.intervalMs = intervalMs;
    this.task = task;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startedAt = null;
    this.lastCompletedAt = null;
  }

  start() {
    this.startedAt = this.now();
    this.#schedule(0);
  }

  stop() {
    this.#stopped = true;
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs) {
    // Un error que no sea de dependencias se deja escapar como unhandledRejection: es fatal (SPEC apartado 9.1).
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      this.tick();
    }, delayMs);
  }

  async tick() {
    const start = this.now();
    try {
      await this.task();
    } catch (err) {
      if (!(err instanceof DependencyError)) throw err;
      this.log.error(`Iteración interrumpida por error de dependencia: ${err.describe()}`);
    }
    // La iteración cuenta como terminada aunque haya fallado contra la API (SPEC apartado 9.2).
    const end = this.now();
    this.lastCompletedAt = end;
    if (this.#stopped) return;

    let nextAt = start + this.intervalMs;
    if (nextAt <= end) {
      this.log.warn(
        `La iteración ha durado ${Math.round((end - start) / 1000)} s, más que la frecuencia configurada ` +
          `(${Math.round(this.intervalMs / 1000)} s). La siguiente empieza inmediatamente.`,
      );
      nextAt = end;
    }
    this.log.info(`Iteración finalizada. Próxima iteración a las ${hhmmss(nextAt)}.`);
    this.#schedule(nextAt - end);
  }
}
