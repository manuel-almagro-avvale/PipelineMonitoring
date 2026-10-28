// Envío de alertas al iFlow con reintentos (SPEC apartado 7).

import { DependencyError, httpRequest, DEFAULT_TIMEOUT_MS } from './http.js';
import { log as defaultLog, redact, truncate } from './logger.js';

export class AlertClient {
  constructor({
    url,
    tokenCache,
    retries = 3,
    retryDelayMs = 10_000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = defaultLog,
  }) {
    this.url = url;
    this.tokenCache = tokenCache;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.log = log;
  }

  // Devuelve true si el envío tuvo éxito en algún intento, false si fallaron todos.
  async send(payload) {
    const attempts = this.retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const failure = await this.#attempt(payload);
      if (failure === null) return true;
      this.log.warn(`Intento ${attempt}/${attempts} de envío de alerta fallido: ${failure}`);
      if (attempt < attempts) await this.sleep(this.retryDelayMs);
    }
    return false;
  }

  // Devuelve null si el intento tuvo éxito, o la descripción del fallo.
  async #attempt(payload) {
    try {
      const token = await this.tokenCache.getToken();
      const res = await httpRequest(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: this.timeoutMs,
      });
      if (res.ok) return null;
      if (res.status === 401) this.tokenCache.invalidate();
      const body = truncate(redact(res.text), 500);
      return `HTTP ${res.status}${body ? ` ${body}` : ''}`;
    } catch (err) {
      if (err instanceof DependencyError) return err.describe();
      throw err;
    }
  }
}
