import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient, UpstreamError } from '../src/index.js';

async function server(handler) {
  const hits = [];
  const s = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res, hits.length);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, hits, close: () => (s.closeAllConnections(), new Promise((r) => s.close(r))) };
}
const json = (res, status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const SECRET = 's'.repeat(32);
const mk = (url, extra = {}) => createClient({ name: 'peer', from: 'me', url, secret: SECRET, retryDelay: 1, maxDelay: 5, ...extra });

test('GET is retried on 503 and succeeds, each attempt freshly signed', async () => {
  const s = await server((req, res, n) => (n < 3 ? json(res, 503, { e: 1 }) : json(res, 200, { ok: true })));
  const res = await mk(s.url).get('/x', { query: { a: [1, 2], b: 'z' } });
  assert.equal(res.status, 200);
  assert.equal(res.attempts, 3);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(s.hits[0].url, '/x?a=1&a=2&b=z');
  const nonces = new Set(s.hits.map((h) => h.headers['x-white-nonce']));
  assert.equal(nonces.size, 3);
  await s.close();
});

test('POST is not retried unless idempotent: true', async () => {
  const s = await server((req, res) => json(res, 503, {}));
  const client = mk(s.url);
  assert.equal((await client.post('/x', { json: { a: 1 } })).status, 503);
  assert.equal(s.hits.length, 1);
  await client.post('/x', { json: {}, idempotent: true, retries: 2 });
  assert.equal(s.hits.length, 4);
  await s.close();
});

test('4xx is returned without retry, retryStatus adds statuses to retry on', async () => {
  const s = await server((req, res) => json(res, 404, { no: 1 }));
  const res = await mk(s.url).get('/missing');
  assert.equal(res.status, 404);
  assert.equal(res.ok, false);
  assert.equal(s.hits.length, 1);
  const teapot = await server((req, res) => json(res, 500, {}));
  await mk(teapot.url).get('/x', { retries: 1, retryStatus: [500] });
  assert.equal(teapot.hits.length, 2);
  await s.close();
  await teapot.close();
});

test('a slow service gives a 504 UpstreamError', async () => {
  const s = await server(() => {}); // never answers
  await assert.rejects(mk(s.url, { retries: 0 }).get('/x', { timeout: 50 }), (e) => e instanceof UpstreamError && e.status === 504 && e.peer === 'peer');
  await s.close();
});

test('an unreachable service gives a 502 and the circuit opens after the threshold', async () => {
  const client = mk('http://127.0.0.1:9', { retries: 0, breaker: { threshold: 2, cooldown: '1h' } });
  for (let i = 0; i < 2; i++) await assert.rejects(client.get('/x'), (e) => e.status === 502);
  await assert.rejects(client.get('/x'), (e) => e.status === 503 && /circuit open/.test(e.message));
  assert.equal(client.breaker.state, 'open');
});

test('redirects are not followed and a path cannot leave the peer', async () => {
  const s = await server((req, res) => res.writeHead(302, { location: 'http://evil.example/' }).end());
  const client = mk(s.url);
  assert.equal((await client.get('/x')).status, 302);
  await assert.rejects(client.get('//evil.example/x'), TypeError);
  await assert.rejects(client.get('http://evil.example/x'), TypeError);
  await s.close();
});

test('client.json throws on a non-2xx answer and keeps the upstream status', async () => {
  const s = await server((req, res) => json(res, 409, { error: 'dup' }));
  await assert.rejects(mk(s.url).json('POST', '/x', { json: {} }), (e) => e.upstreamStatus === 409 && e.response.json.error === 'dup');
  await s.close();
});

test('an oversized response is refused', async () => {
  const s = await server((req, res) => res.end('x'.repeat(5000)));
  await assert.rejects(mk(s.url, { maxResponse: 100 }).get('/x'), /too large/);
  await s.close();
});

test('caller headers cannot override the signature', async () => {
  const s = await server((req, res) => json(res, 200, {}));
  await mk(s.url).get('/x', { headers: { 'X-White-Service': 'admin', 'X-Custom': '1' } });
  assert.equal(s.hits[0].headers['x-white-service'], 'me');
  assert.equal(s.hits[0].headers['x-custom'], '1');
  await s.close();
});
