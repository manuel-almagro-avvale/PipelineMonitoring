// Clientes HTTP contra un servidor local real: OAuth, API de Integration Suite y alertas.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import { AlertClient } from '../src/alertClient.js';
import { CpiClient, ReadOnlyViolationError, queuePath } from '../src/cpiClient.js';
import { DependencyError } from '../src/http.js';
import { TokenCache } from '../src/oauth.js';
import { fakeLog } from './helpers.js';

let server;
let base;
let handler;
const requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function routes(map) {
  requests.length = 0;
  handler = (req, res, body) => {
    const route = map[`${req.method} ${req.url.split('?')[0]}`];
    if (route) route(req, res, body);
    else json(res, 404, { error: 'not found' });
  };
}

const tokenRoute = (counter, expiresIn = 3600) => (req, res) => {
  counter.n++;
  json(res, 200, { access_token: `tok${counter.n}`, expires_in: expiresIn });
};

function tokenCache(opts = {}) {
  return new TokenCache({ clientId: 'id', clientSecret: 'secret', tokenUrl: `${base}/oauth/token`, label: 'test', ...opts });
}

test('queuePath escapa comillas simples y caracteres especiales', () => {
  assert.equal(queuePath('JMS_ORDERS'), "/MessagingQueues('JMS_ORDERS')");
  assert.equal(queuePath("Q'A B/C"), "/MessagingQueues('Q''A%20B%2FC')");
});

test('el cliente CPI solo permite GET', () => {
  const cpi = new CpiClient({ baseUrl: base, tokenCache: tokenCache() });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'MERGE', 'get']) {
    assert.throws(() => cpi.request(method, '/MessagingQueues'), ReadOnlyViolationError);
  }
  assert.equal(requests.length, 0);
});

test('el token se cachea y se reutiliza; un 401 lo invalida', async () => {
  const tokens = { n: 0 };
  let fail = false;
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    'GET /api/v1/MessagingQueues': (req, res) =>
      fail ? json(res, 401, 'Unauthorized') : json(res, 200, { d: { results: [{ queueName: 'Q1' }] } }),
  });
  const cpi = new CpiClient({ baseUrl: `${base}/api/v1`, tokenCache: tokenCache() });

  await cpi.listQueues();
  await cpi.listQueues();
  assert.equal(tokens.n, 1);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer tok1');
  assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(requests[0].body, 'grant_type=client_credentials');

  fail = true;
  await assert.rejects(cpi.listQueues(), (err) => err instanceof DependencyError && err.status === 401);
  fail = false;
  await cpi.listQueues();
  assert.equal(tokens.n, 2);
});

test('el token se renueva 60 s antes de expirar', async () => {
  const tokens = { n: 0 };
  routes({ 'POST /oauth/token': tokenRoute(tokens, 120) });
  let clock = 0;
  const cache = tokenCache({ now: () => clock });
  await cache.getToken();
  clock = 59_000;
  await cache.getToken();
  assert.equal(tokens.n, 1);
  clock = 60_000;
  await cache.getToken();
  assert.equal(tokens.n, 2);
});

test('errores de la API: cuerpo truncado y sin secretos', async () => {
  const tokens = { n: 0 };
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    'GET /api/v1/MessagingQueues': (req, res) =>
      json(res, 500, `{"access_token":"leaked","clientsecret":"secret"} Authorization: Bearer abc.def ${'x'.repeat(1000)}`),
  });
  const cpi = new CpiClient({ baseUrl: `${base}/api/v1`, tokenCache: tokenCache() });
  const err = await cpi.listQueues().catch((e) => e);
  assert.ok(err instanceof DependencyError);
  const text = err.describe();
  assert.match(text, /HTTP: 500/);
  assert.match(text, /MessagingQueues/);
  assert.ok(!text.includes('leaked'));
  assert.ok(!text.includes('abc.def'));
  assert.ok(err.body.length < 520);
});

test('respuesta no JSON y timeout se convierten en DependencyError', async () => {
  const tokens = { n: 0 };
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    'GET /api/v1/MessagingQueues': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>login</html>');
    },
    "GET /api/v1/MessagingQueues('SLOW')/MessagingMessages": () => {},
  });
  const cpi = new CpiClient({ baseUrl: `${base}/api/v1`, tokenCache: tokenCache(), timeoutMs: 200 });
  await assert.rejects(cpi.listQueues(), /no parseable/);
  await assert.rejects(cpi.listMessages('SLOW'), /Timeout/);
});

test('findMessage filtra por jmsMessageId codificado', async () => {
  const tokens = { n: 0 };
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    "GET /api/v1/MessagingQueues('Q1')/MessagingMessages": (req, res) => json(res, 200, { d: { results: [] } }),
  });
  const cpi = new CpiClient({ baseUrl: `${base}/api/v1`, tokenCache: tokenCache() });
  await cpi.findMessage('Q1', 'ID:abc/1+2');
  assert.equal(requests.at(-1).url, "/api/v1/MessagingQueues('Q1')/MessagingMessages?jmsMessageId=ID%3Aabc%2F1%2B2&$format=json");
});

test('alertas: reintenta hasta 4 intentos y reporta el fallo', async () => {
  const tokens = { n: 0 };
  let calls = 0;
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    'POST /http/alert': (req, res) => {
      calls++;
      json(res, 503, 'unavailable');
    },
  });
  const sleeps = [];
  const log = fakeLog();
  const alerter = new AlertClient({
    url: `${base}/http/alert`,
    tokenCache: tokenCache(),
    sleep: async (ms) => sleeps.push(ms),
    log,
  });
  assert.equal(await alerter.send({ a: 1 }), false);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  assert.ok(log.has('warn', 'Intento 4/4'));
  assert.ok(log.has('warn', 'HTTP 503'));
});

test('alertas: éxito tras un fallo, con JSON y token', async () => {
  const tokens = { n: 0 };
  let calls = 0;
  routes({
    'POST /oauth/token': tokenRoute(tokens),
    'POST /http/alert': (req, res) => {
      calls++;
      if (calls === 1) json(res, 500, 'boom');
      else json(res, 200, {});
    },
  });
  const alerter = new AlertClient({ url: `${base}/http/alert`, tokenCache: tokenCache(), sleep: async () => {}, log: fakeLog() });
  assert.equal(await alerter.send({ Client: 'X' }), true);
  const last = requests.at(-1);
  assert.equal(last.headers['content-type'], 'application/json');
  assert.equal(last.headers.authorization, 'Bearer tok1');
  assert.deepEqual(JSON.parse(last.body), { Client: 'X' });
});
