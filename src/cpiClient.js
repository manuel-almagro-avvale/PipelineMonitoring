// Cliente de la API OData de Integration Suite. SOLO LECTURA (SPEC apartado 3):
// cualquier método distinto de GET lanza una excepción antes de tocar la red.

import { DependencyError, httpRequest, parseJson, DEFAULT_TIMEOUT_MS } from './http.js';

export class ReadOnlyViolationError extends Error {
  constructor(method) {
    super(`Método HTTP ${method} no permitido: el cliente de la API de Integration Suite es de solo lectura.`);
    this.name = 'ReadOnlyViolationError';
  }
}

// queueName es un literal OData entre comillas simples: las comillas se duplican y el resultado se codifica.
export function queuePath(queueName) {
  return `/MessagingQueues('${encodeURIComponent(queueName.replace(/'/g, "''"))}')`;
}

export class CpiClient {
  constructor({ baseUrl, tokenCache, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenCache = tokenCache;
    this.timeoutMs = timeoutMs;
  }

  // No es async a propósito: la comprobación de método lanza de forma síncrona.
  request(method, path) {
    if (method !== 'GET') throw new ReadOnlyViolationError(method);
    return this.#get(this.baseUrl + path);
  }

  get(path) {
    return this.request('GET', path);
  }

  listQueues() {
    return this.get('/MessagingQueues');
  }

  listMessages(queueName) {
    return this.get(`${queuePath(queueName)}/MessagingMessages?$format=json`);
  }

  findMessage(queueName, jmsMessageId) {
    return this.get(
      `${queuePath(queueName)}/MessagingMessages?jmsMessageId=${encodeURIComponent(jmsMessageId)}&$format=json`,
    );
  }

  async #get(url) {
    const token = await this.tokenCache.getToken();
    const res = await httpRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 401) this.tokenCache.invalidate();
    if (!res.ok) {
      throw new DependencyError('Error en la API de Integration Suite', {
        endpoint: url,
        status: res.status,
        body: res.text,
      });
    }
    const json = parseJson(res.text, url, res.status);
    const results = json?.d?.results;
    if (!Array.isArray(results)) {
      throw new DependencyError('Respuesta inesperada de la API de Integration Suite (falta d.results)', {
        endpoint: url,
        status: res.status,
        body: res.text,
      });
    }
    return results;
  }
}
