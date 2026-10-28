// Endpoint /health para el health check http de CF (SPEC apartado 9.2).
// Mide si el bucle está vivo, no la salud de las dependencias. No expone información interna.

import http from 'node:http';

export function isHealthy({ startedAt, lastCompletedAt, limitMs, now }) {
  if (lastCompletedAt === null) return startedAt !== null && now - startedAt < limitMs;
  return now - lastCompletedAt < limitMs;
}

export function createHealthServer(check) {
  return http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"status":"NOT_FOUND"}');
      return;
    }
    const up = check();
    res.writeHead(up ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: up ? 'UP' : 'DOWN' }));
  });
}
