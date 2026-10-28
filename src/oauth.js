// OAuth 2.0 client credentials con caché del token en memoria (SPEC apartado 4).

import { DependencyError, httpRequest, parseJson, DEFAULT_TIMEOUT_MS } from './http.js';

const EXPIRY_MARGIN_S = 60;

export class TokenCache {
  #token = null;
  #expiresAt = 0;

  constructor({ clientId, clientSecret, tokenUrl, label, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenUrl = tokenUrl;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async getToken() {
    if (this.#token && this.now() < this.#expiresAt) return this.#token;
    return this.#fetchToken();
  }

  invalidate() {
    this.#token = null;
    this.#expiresAt = 0;
  }

  async #fetchToken() {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await httpRequest(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) {
      throw new DependencyError(`Error obteniendo token OAuth (${this.label})`, {
        endpoint: this.tokenUrl,
        status: res.status,
        body: res.text,
      });
    }
    const json = parseJson(res.text, this.tokenUrl, res.status);
    if (typeof json?.access_token !== 'string' || json.access_token === '') {
      throw new DependencyError(`Respuesta OAuth sin access_token (${this.label})`, {
        endpoint: this.tokenUrl,
        status: res.status,
      });
    }
    const expiresIn = Number(json.expires_in);
    const lifetimeS = Number.isFinite(expiresIn) ? Math.max(0, expiresIn - EXPIRY_MARGIN_S) : 0;
    this.#token = json.access_token;
    this.#expiresAt = this.now() + lifetimeS * 1000;
    return this.#token;
  }
}
