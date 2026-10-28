// Envoltorio mínimo sobre fetch con timeout y errores homogéneos para dependencias externas.

import { redact, truncate } from './logger.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

// Error de una dependencia externa (API de Integration Suite, servidor OAuth, endpoint de alertas).
// Nunca debe tumbar la app: termina la iteración en curso y se registra.
export class DependencyError extends Error {
  constructor(message, { endpoint, status = null, body = '' } = {}) {
    super(message);
    this.name = 'DependencyError';
    this.endpoint = endpoint;
    this.status = status;
    this.body = truncate(redact(body), 500);
  }

  describe() {
    const parts = [`${this.message} [endpoint: ${this.endpoint}, HTTP: ${this.status ?? '-'}]`];
    if (this.body) parts.push(`Respuesta: ${this.body}`);
    return parts.join(' ');
  }
}

export async function httpRequest(url, { method, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Timeout tras ${timeoutMs / 1000} s`
        : `Error de red: ${err?.cause?.message ?? err?.message ?? err}`;
    throw new DependencyError(reason, { endpoint: url });
  }
}

export function parseJson(text, endpoint, status) {
  try {
    return JSON.parse(text);
  } catch {
    throw new DependencyError('Respuesta no parseable (no es JSON)', { endpoint, status, body: text });
  }
}
