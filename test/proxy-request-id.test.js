import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, ConfigError } from '../src/index.js';
import { normalizeTrustProxy } from '../src/core/proxy.js';
import { createTestClient, createTestCluster } from '../src/test.js';

// ── trustProxy ──

test('trustProxy: the default trusts nobody, and `true` is refused', () => {
  assert.equal(normalizeTrustProxy(undefined).setting, false);
  assert.equal(resolveConfig({}).trustProxy, false);
  assert.throws(() => resolveConfig({ trustProxy: true }), (e) => e instanceof ConfigError && /forge/.test(e.message) && /hop count/.test(e.hint));
});

test('trustProxy accepts hops, subnets, keywords and objects, and rejects nonsense', () => {
  assert.equal(normalizeTrustProxy(1).setting, 1);
  assert.equal(normalizeTrustProxy(0).setting, false);
  assert.deepEqual(normalizeTrustProxy('10.0.0.0/8, loopback').setting, ['10.0.0.0/8', 'loopback']);
  assert.deepEqual(normalizeTrustProxy({ proxies: ['::1', 'fd00::/8'] }).setting, ['::1', 'fd00::/8']);
  assert.equal(normalizeTrustProxy({ hops: 2 }).setting, 2);
  for (const bad of [-1, 1.5, 100, '0.0.0.0/0', 'not-an-ip', ['10.0.0.0/33'], [], '*', { hops: 1, proxies: [] }]) {
    assert.throws(() => normalizeTrustProxy(bad), ConfigError, JSON.stringify(bad));
  }
});

const ip = (c, headers) => c.get('/ip', { headers });
const withIp = (trustProxy) => ({ trustProxy, plugins: [(app) => app.get('/ip', (req, res) => res.json({ ip: req.ip, proto: req.protocol }))] });

test('X-Forwarded-For cannot forge the client address unless the proxy is trusted', async () => {
  const forged = { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' };
  const untrusted = await createTestClient(withIp(false));
  const a = (await ip(untrusted, forged)).json;
  assert.notEqual(a.ip, '6.6.6.6');
  assert.equal(a.proto, 'http');
  await untrusted.close();

  const trusted = await createTestClient(withIp('loopback'));
  const b = (await ip(trusted, forged)).json;
  assert.equal(b.ip, '6.6.6.6');
  assert.equal(b.proto, 'https');
  await trusted.close();

  const elsewhere = await createTestClient(withIp(['10.0.0.0/8'])); // the test connects from 127.0.0.1: not trusted
  assert.notEqual((await ip(elsewhere, forged)).json.ip, '6.6.6.6');
  await elsewhere.close();
});

// ── Request ID ──

const id = async (config, headers) => {
  const c = await createTestClient({ plugins: [(app) => app.get('/id', (req, res) => res.json({ id: req.id, source: req.requestIdSource }))], ...config });
  const res = await c.get('/id', { headers });
  await c.close();
  return { ...res.json, header: res.headers.get(config.requestId?.header ?? 'x-request-id') };
};

test('by default a client cannot choose its request id; a generated UUID is used', async () => {
  const r = await id({}, { 'x-request-id': 'attacker-chosen-id' });
  assert.notEqual(r.id, 'attacker-chosen-id');
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.header, r.id);
  assert.equal(r.source, 'generated');
});

test('a trusted proxy may supply the id, if it is well-formed', async () => {
  const config = { trustProxy: 'loopback' };
  assert.equal((await id(config, { 'x-request-id': 'edge-proxy-123' })).id, 'edge-proxy-123');
  for (const bad of ['short', 'has space in it', 'x'.repeat(65), 'bad<script>chars']) {
    const r = await id(config, { 'x-request-id': bad });
    assert.notEqual(r.id, bad, bad);
  }
});

test('requestId.accept: "always" restores the old behaviour, "never" ignores even a trusted proxy', async () => {
  assert.equal((await id({ requestId: { accept: 'always' } }, { 'x-request-id': 'client-chosen-1' })).id, 'client-chosen-1');
  assert.notEqual((await id({ trustProxy: 'loopback', requestId: { accept: 'never' } }, { 'x-request-id': 'edge-proxy-123' })).id, 'edge-proxy-123');
});

test('a custom generator and header name are honoured; a bad generator falls back', async () => {
  const r = await id({ requestId: { header: 'x-trace', generate: () => 'trace-0000001' } });
  assert.equal(r.id, 'trace-0000001');
  assert.equal(r.header, 'trace-0000001');
  const bad = await id({ requestId: { generate: () => 'no' } });
  assert.match(bad.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => resolveConfig({ requestId: { accept: 'sometimes' } }), ConfigError);
});

test('one request id follows a user action through a service call', async () => {
  const cluster = await createTestCluster(
    {
      web: { config: { dirs: { routes: 'test/fixtures/web/routes' } }, peers: ['billing'] },
      billing: { config: { dirs: { routes: 'test/fixtures/billing/routes' } } },
    },
    { root: process.cwd() },
  );
  const res = await cluster.services.web.post('/api/relay', { json: { hello: 'world' } });
  assert.equal(res.status, 200);
  const webId = res.json.requestId;
  assert.match(webId, /^[0-9a-f-]{36}$/);
  assert.equal(res.json.upstream.from, 'web');
  assert.equal(res.json.upstream.requestId, webId, 'billing adopted the id of the calling service');
  assert.equal(res.headers.get('x-request-id'), webId);
  await cluster.close();
});
