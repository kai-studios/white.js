import test from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, verifyRequest, SignatureError, createNonceStore, createBreaker, normalizeMesh, ConfigError } from '../src/index.js';
import { HEADERS } from '../src/mesh/sign.js';

const SECRET = 'x'.repeat(40);
const base = { method: 'POST', target: '/api/internal/x?a=1', body: Buffer.from('{"a":1}'), from: 'web', to: 'billing' };

const verify = (headers, over = {}, nonces = createNonceStore()) =>
  verifyRequest({
    header: (h) => headers[h],
    method: base.method,
    target: base.target,
    body: base.body,
    to: 'billing',
    secretFor: (n) => (n === 'web' ? SECRET : undefined),
    skew: 60_000,
    nonces,
    ...over,
  });

test('a signed request verifies', async () => {
  const headers = signRequest(SECRET, base);
  assert.deepEqual(await verify(headers), { from: 'web' });
});

test('changing the body, path, method, receiver or secret breaks the signature', async () => {
  const headers = signRequest(SECRET, base);
  for (const over of [{ body: Buffer.from('{"a":2}') }, { target: '/api/internal/x?a=2' }, { method: 'PUT' }, { to: 'users' }, { secretFor: () => 'y'.repeat(40) }]) {
    await assert.rejects(verify(headers, over), SignatureError);
  }
});

test('a request is accepted once (replay protection)', async () => {
  const headers = signRequest(SECRET, base);
  const nonces = createNonceStore();
  await verify(headers, {}, nonces);
  await assert.rejects(verify(headers, {}, nonces), /replayed/);
});

test('old and future timestamps are refused', async () => {
  const old = signRequest(SECRET, { ...base, now: Date.now() - 5 * 60_000 });
  const future = signRequest(SECRET, { ...base, now: Date.now() + 5 * 60_000 });
  await assert.rejects(verify(old), /window/);
  await assert.rejects(verify(future), /window/);
});

test('unknown service, missing and malformed headers are refused', async () => {
  const headers = signRequest(SECRET, { ...base, from: 'stranger' });
  await assert.rejects(verify(headers), /unknown service/);
  await assert.rejects(verify({}), /missing/);
  await assert.rejects(verify({ ...signRequest(SECRET, base), [HEADERS.service]: 'web\nbilling' }), /bad service name/);
});

test('a failed signature does not use up the nonce', async () => {
  const nonces = createNonceStore();
  const headers = signRequest(SECRET, base);
  await assert.rejects(verify({ ...headers, [HEADERS.signature]: '0'.repeat(64) }, {}, nonces));
  assert.equal(nonces.size, 0);
});

test('nonce store expires entries and claims atomically', () => {
  let t = 1000;
  const store = createNonceStore({ now: () => t });
  assert.equal(store.claim('a', 100), true);
  assert.equal(store.claim('a', 100), false);
  t += 101;
  assert.equal(store.claim('a', 100), true);
  store.release('a');
  assert.equal(store.claim('a', 100), true);
});

test('circuit breaker opens, probes after the cooldown, and closes again', () => {
  let t = 0;
  const b = createBreaker({ threshold: 3, cooldown: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.equal(b.allow(), true);
    b.failure();
  }
  assert.equal(b.state, 'open');
  assert.equal(b.allow(), false);
  t += 1000;
  assert.equal(b.state, 'half-open');
  assert.equal(b.allow(), true); // the probe
  assert.equal(b.allow(), false); // only one at a time
  b.failure();
  assert.equal(b.state, 'open');
  t += 1000;
  assert.equal(b.allow(), true);
  b.success();
  assert.equal(b.state, 'closed');
});

test('a success resets the count of failures in a row', () => {
  const b = createBreaker({ threshold: 3 });
  b.failure();
  b.failure();
  b.success();
  b.failure();
  b.failure();
  assert.equal(b.state, 'closed');
});

test('mesh config: every problem is reported at once', () => {
  assert.throws(
    () => normalizeMesh({ peers: { 'bad name': 'ftp://x', a: { url: 'http://a' } }, accept: ['b'], protect: ['nope'] }),
    (err) => err instanceof ConfigError && /mesh\.name/.test(err.message) && /ftp|http\(s\)/.test(err.message) && /no secret/.test(err.message) && /protect/.test(err.message),
  );
  assert.equal(normalizeMesh(false), null);
  const ok = normalizeMesh({ name: 'web', secret: SECRET, peers: { billing: 'http://billing:3000' }, timeout: '2s' });
  assert.equal(ok.peers.billing.timeout, 2000);
  assert.equal(ok.peers.billing.retries, 2);
  assert.deepEqual(ok.protect, ['/internal', '/api/internal']);
});
