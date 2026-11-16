import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCluster, createTestClient } from '../src/test.js';
import { signRequest, createClient } from '../src/index.js';

const SECRET = 'k'.repeat(40);
const JSON_ACCEPT = { accept: 'application/json' };
const web = { dirs: { routes: 'test/fixtures/web/routes' } };
const billing = { dirs: { routes: 'test/fixtures/billing/routes' } };

// Runs the body with a cluster and always closes it, so a failed assertion cannot leave servers open
async function withCluster(definitions, body) {
  const c = await createTestCluster(
    definitions ?? { web: { config: web, peers: ['billing'] }, billing: { config: billing } },
  );
  try {
    await body(c.services, c);
  } finally {
    await c.close();
  }
}

test('web calls a protected billing route through the mesh', () =>
  withCluster(null, async (s) => {
    const res = await s.web.post('/api/relay', { json: { amount: 5 }, headers: JSON_ACCEPT });
    assert.equal(res.status, 200);
    assert.equal(res.json.upstream.from, 'web');
    assert.deepEqual(res.json.upstream.body, { amount: 5 });
    // the request id travelled with the call (the async context survives the body parser)
    assert.equal(res.json.upstream.requestId, res.json.requestId);
    // billing's public route stays public, the internal one does not
    assert.equal((await s.billing.get('/api/public')).status, 200);
    assert.equal((await s.billing.post('/api/internal/echo', { json: {}, headers: JSON_ACCEPT })).status, 401);
  }));

test('unsigned and forged requests get the same generic 401', () =>
  withCluster(null, async (s) => {
    const none = await s.billing.post('/api/internal/echo', { json: {}, headers: JSON_ACCEPT });
    const forged = await s.billing.post('/api/internal/echo', {
      json: {},
      headers: {
        ...JSON_ACCEPT,
        ...signRequest(SECRET, { method: 'POST', target: '/api/internal/echo', body: Buffer.from('{}'), from: 'web', to: 'billing' }),
      },
    });
    assert.equal(none.status, 401);
    assert.equal(forged.status, 401);
    assert.equal(none.json.error, forged.json.error);
  }));

test('a captured request cannot be sent again', () =>
  withCluster(
    {
      web: { config: { ...web, mesh: { peers: { billing: { secret: SECRET } } } }, peers: ['billing'] },
      billing: { config: { ...billing, mesh: { peers: { web: { secret: SECRET } } } } },
    },
    async (s) => {
      const body = JSON.stringify({ a: 1 });
      const headers = {
        ...JSON_ACCEPT,
        'content-type': 'application/json',
        ...signRequest(SECRET, { method: 'POST', target: '/api/internal/echo', body: Buffer.from(body), from: 'web', to: 'billing' }),
      };
      const send = () => fetch(s.billing.url + '/api/internal/echo', { method: 'POST', headers, body });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 401); // same nonce
    },
  ));

test('route-level allow list on top of a protected prefix', () =>
  withCluster(null, async (s) => {
    const res = await s.web.ctx.mesh.peer('billing').get('/api/internal/admin');
    assert.equal(res.status, 403);
  }));

test('retries make a flaky peer look healthy to the route', () =>
  withCluster(null, async (s) => {
    const res = await s.web.get('/api/relay/flaky', { headers: JSON_ACCEPT });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  }));

test('a dead peer becomes a 5xx for the user, not a hang', () =>
  withCluster(null, async (s) => {
    await s.billing.close();
    const res = await s.web.post('/api/relay', { json: {}, headers: JSON_ACCEPT });
    assert.ok([502, 503, 504].includes(res.status), `status ${res.status}`);
  }));

test('events: delivered once, wildcards, duplicates ignored, failures retried', () =>
  withCluster(null, async (s) => {
    const seen = [];
    s.billing.ctx.mesh.on('user.*', (e) => seen.push([e.type, e.from, e.data]));
    s.billing.ctx.mesh.on('*', (e) => seen.push(['any', e.type]));

    const out = await s.web.ctx.mesh.emit('user.created', { id: 7 });
    assert.deepEqual(out.delivered, ['billing']);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(seen, [['user.created', 'web', { id: 7 }], ['any', 'user.created']]);

    // the same event id twice (a sender retrying after a lost answer): handlers run once
    const peer = s.web.ctx.mesh.peer('billing');
    const event = { id: 'fixed-event-id-1', type: 'user.deleted', data: {} };
    await peer.post('/_white/events', { json: event });
    const again = await peer.post('/_white/events', { json: event });
    assert.equal(again.json.duplicate, true);
    assert.equal(seen.filter((e) => e[0] === 'user.deleted').length, 1);

    // a handler that fails once: the id is released and the sender's retry runs it again
    let calls = 0;
    s.billing.ctx.mesh.on('job.run', () => {
      if (++calls === 1) throw new Error('boom');
    });
    const res = await s.web.ctx.mesh.emit('job.run', {});
    assert.deepEqual(res.delivered, ['billing']);
    assert.equal(calls, 2);

    assert.equal((await peer.post('/_white/events', { json: { id: 'x-valid-id-1', type: 'bad type!' } })).status, 400);
  }));

test('emit reports a peer that cannot be reached instead of throwing', () =>
  withCluster(null, async (s) => {
    await s.billing.close();
    const res = await s.web.ctx.mesh.emit('user.created', {}, { timeout: 200 });
    assert.equal(res.delivered.length, 0);
    assert.equal(res.failed[0].peer, 'billing');
  }));

test('ping, status, manifest and readiness', () =>
  withCluster(
    {
      web: { config: { ...web, mesh: { peers: { billing: { required: true } } } }, peers: ['billing'] },
      billing: { config: { ...billing, mesh: { meta: { region: 'eu' } } } },
    },
    async (s) => {
      const [state] = await s.web.ctx.mesh.status();
      assert.equal(state.ok, true);
      assert.equal(state.name, 'billing');

      const manifest = await s.web.ctx.mesh.peer('billing').get('/_white/manifest');
      assert.equal(manifest.json.service, 'billing');
      assert.equal(manifest.json.meta.region, 'eu');
      assert.ok(manifest.json.routes.some((r) => r.path === '/api/internal/echo' && r.method === 'POST'));

      assert.equal((await s.web.get('/ready')).status, 200);
      await s.billing.close();
      s.web.ctx.cache.clear(); // readiness of a peer is cached for 5 seconds
      const down = await s.web.get('/ready');
      assert.equal(down.status, 503);
      assert.deepEqual(down.json.failed, ['mesh:billing']);
      assert.equal((await s.web.get('/health')).status, 200); // liveness does not depend on peers
    },
  ));

test('a valid signature from a service we do not know is refused', () =>
  withCluster(null, async (s) => {
    const outsider = createClient({ name: 'billing', from: 'intruder', url: s.billing.url, secret: 'z'.repeat(40) });
    assert.equal((await outsider.get('/api/internal/admin', { retries: 0 })).status, 401);
  }));

test('without a mesh config nothing changes', async () => {
  const client = await createTestClient(web);
  try {
    assert.equal(client.ctx.mesh, undefined);
    assert.equal((await client.get('/_white/ping')).status, 404);
    assert.equal((await client.get('/health')).status, 200);
  } finally {
    await client.close();
  }
});
