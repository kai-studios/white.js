import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolRegistry, ProtocolError, createCompatibilityEngine, loadProtocolState, resolveConfig } from '../src/index.js';
import { parseRef, compareProtocolVersions, validateProtocolManifest, readLibraryManifest } from '../src/protocols/index.js';
import { enforce } from '../src/protocols/index.js';
import { createTestClient } from '../src/test.js';
import { metaProject, protocolManifests } from './helpers/meta.js';
import { tmpProject, installPackage } from './helpers/project.js';

const manifest = (over = {}) => ({ name: 'meta', version: '3.0', status: 'current', ...over });
const registryWith = (...ms) => {
  const r = new ProtocolRegistry();
  ms.flat().forEach((m) => r.register(m, { source: 'test' }));
  return r;
};

// ── Versions ──

test('protocol versions are MAJOR.MINOR, ordered numerically', () => {
  assert.deepEqual(parseRef('meta@3.0'), { name: 'meta', version: '3.0', id: 'meta@3.0' });
  assert.ok(compareProtocolVersions('2.10', '2.9') > 0);
  for (const bad of ['meta', 'meta@3', 'meta@3.0.1', 'Meta@3.0', 'meta@v3.0', 'a@b@c']) assert.throws(() => parseRef(bad), TypeError, bad);
});

// ── Registry ──

test('registering protocols and several versions', () => {
  const r = registryWith(protocolManifests());
  assert.deepEqual(r.names(), ['meta']);
  assert.deepEqual(r.versions('meta').map((m) => m.version), ['3.0', '2.0']);
  assert.equal(r.current('meta').version, '3.0');
  assert.equal(r.statusOf('meta', '2.0'), 'deprecated');
  assert.equal(r.find('meta@3.0').replaces, 'meta@2.0');
});

test('looking up a missing protocol or version', () => {
  const r = registryWith(manifest());
  assert.equal(r.get('meta', '9.9'), undefined);
  assert.equal(r.get('nope', '1.0'), undefined);
  assert.equal(r.has('meta', '9.9'), false);
  assert.equal(r.statusOf('meta', '9.9'), undefined);
  assert.equal(r.isUsable('meta', '9.9'), false);
  assert.equal(r.current('nope'), undefined);
});

test('changing a status; blocking needs a reason or an advisory', () => {
  const r = registryWith(manifest({ version: '2.0', status: 'current' }));
  r.setStatus('meta', '2.0', 'deprecated');
  assert.equal(r.statusOf('meta', '2.0'), 'deprecated');
  r.setStatus('meta', '2.0', 'blocked', { reason: 'CVE' });
  assert.equal(r.isUsable('meta', '2.0'), false);
  assert.throws(() => r.setStatus('meta', '2.0', 'weird'), ProtocolError);
  assert.throws(() => r.setStatus('meta', '9.9', 'blocked'), ProtocolError);
});

test('re-registering the same manifest is fine; a different one is refused', () => {
  const r = registryWith(manifest());
  r.register(manifest());
  assert.throws(() => r.register(manifest({ status: 'deprecated' })), /defined twice/);
});

test('invalid manifests are rejected with every problem listed', () => {
  const { problems } = validateProtocolManifest({ name: 'Bad Name', version: '3', status: 'great', compatibility: { white: 'not a range', protocols: ['other@1.0', 'meta@3.0'] }, migration: { from: 'meta@2.0', to: 'meta@9.9', strategy: 'magic' } });
  assert.ok(problems.length >= 6);
  assert.throws(() => registryWith({ name: 'meta', version: '1.0', status: 'blocked' }), /needs an "advisory"/);
});

test('a frozen registry cannot change; it has a stable fingerprint and survives JSON', () => {
  const r = registryWith(protocolManifests());
  const before = r.fingerprint();
  r.freeze();
  assert.throws(() => r.register(manifest({ version: '4.0' })), /frozen/);
  assert.throws(() => r.setStatus('meta', '3.0', 'blocked', { reason: 'x' }), /frozen/);
  assert.throws(() => r.addImplementation('meta', '3.0', { source: 'x' }), /frozen/);
  assert.equal(r.fingerprint(), before);
  assert.equal(registryWith(protocolManifests()).fingerprint(), before, 'same content, same fingerprint');
  assert.notEqual(registryWith(protocolManifests().slice(0, 1)).fingerprint(), before);
  assert.equal(JSON.parse(JSON.stringify(r)).protocols[0].versions.length, 2);
  assert.throws(() => (r.get('meta', '3.0').status = 'blocked'), TypeError, 'manifests are immutable');
});

test('two registries do not share state', () => {
  const a = registryWith(manifest());
  const b = new ProtocolRegistry();
  assert.equal(b.has('meta'), false);
  assert.equal(a.has('meta'), true);
});

test('interoperability is explicit and not transitive', () => {
  const r = registryWith(
    { name: 'meta', version: '2.0', status: 'supported' },
    { name: 'meta', version: '2.1', status: 'supported', compatibility: { protocols: ['meta@2.0'] } },
    { name: 'meta', version: '2.2', status: 'current', compatibility: { protocols: ['meta@2.1'] } },
  );
  assert.equal(r.interoperable('meta', '2.0', '2.1'), true);
  assert.equal(r.interoperable('meta', '2.1', '2.0'), true);
  assert.equal(r.interoperable('meta', '2.1', '2.2'), true);
  assert.equal(r.interoperable('meta', '2.0', '2.2'), false, 'not inferred through 2.1');
  assert.equal(r.interoperable('meta', '2.0', '2.0'), true);
});

test('migration paths follow declared steps, through several hops', () => {
  const r = registryWith(
    { name: 'meta', version: '2.0', status: 'deprecated' },
    { name: 'meta', version: '3.0', status: 'supported', migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic' } },
    { name: 'meta', version: '4.0', status: 'current', migration: { from: 'meta@3.0', to: 'meta@4.0', strategy: 'manual' } },
    { name: 'meta', version: '1.0', status: 'removed' },
  );
  assert.deepEqual(r.pathTo('meta', '2.0', '4.0').map((e) => e.to), ['3.0', '4.0']);
  assert.deepEqual(r.pathTo('meta', '3.0', '3.0'), []);
  assert.equal(r.pathTo('meta', '1.0', '4.0'), null, 'no declared route');
  assert.equal(r.pathTo('meta', '4.0', '2.0'), null, 'no downgrade');
});

// ── Library manifests ──

test('library manifests are validated; unknown "required" must be supported', () => {
  assert.equal(readLibraryManifest({ name: 'x' }).library, null);
  const ok = readLibraryManifest({ name: 'x', version: '1.0.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } } });
  assert.deepEqual(ok.library.protocols.meta.supported, ['2.0', '3.0']);
  const bad = readLibraryManifest({ name: 'x', white: { protocols: { meta: { required: '2.0', supported: ['3.0'] }, Bad: {} }, framework: 'nope', migrations: '../evil.js' } });
  assert.equal(bad.library, null);
  assert.ok(bad.problems.length >= 4);
});

// ── Compatibility engine on the specification's scenario ──

const analyze = (project, config = {}) => {
  const state = loadProtocolState(resolveConfig(config), project.root, { framework: '0.4.0' });
  return state.report;
};
const codes = (report, severity) => report.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);

test('several generations of one protocol coexist (the 0.3.0 example)', () => {
  const p = metaProject();
  const r = analyze(p);
  assert.deepEqual(r.users.filter((u) => u.protocol === 'meta').map((u) => `${u.subject} ${u.version}`).sort(), ['white-auth 2.0', 'white-cache 2.0', 'white-mesh 3.0']);
  assert.equal(r.summary.error, 0);
  assert.equal(r.summary.critical, 0);
  assert.equal(r.status, 'WARNING');
  assert.deepEqual(codes(r, 'warning'), ['deprecated-version', 'deprecated-version']);
});

test('recommendations: switch what supports the new generation, update what does not', () => {
  const r = analyze(metaProject());
  const auth = r.recommendations.find((x) => x.subject === 'white-auth');
  const cache = r.recommendations.find((x) => x.subject === 'white-cache');
  assert.deepEqual([auth.action, auth.to, auth.migration], ['switch', '3.0', 'automatic']);
  assert.deepEqual([cache.action, cache.to], ['update-library', '3.0']);
  assert.deepEqual(r.migrations, { automatic: 1, manual: 0 });
});

test('a framework version outside the declared range is an error', () => {
  const p = metaProject({ manifests: protocolManifests({ compatibility: { white: '>=1.0.0' } }) });
  const r = analyze(p);
  assert.ok(codes(r, 'error').includes('framework-incompatible'));
  const lib = metaProject({ libs: { 'white-mesh': {} } });
  installPackage(lib, 'white-mesh', { version: '3.1.0', white: { framework: '^9.0.0', protocols: { meta: { required: '3.0' } } } });
  assert.ok(codes(analyze(lib), 'error').includes('library-framework-incompatible'));
});

test('a blocked version is critical, names the advisory, and says that updating the library is not enough', () => {
  const p = metaProject({ manifests: protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', advisory: { id: 'WHITE-2026-001', severity: 'critical', summary: 'signature bypass' } } : m)) });
  const r = analyze(p);
  assert.equal(r.status, 'CRITICAL');
  const f = r.findings.find((x) => x.code === 'blocked-version');
  assert.equal(f.severity, 'critical');
  assert.match(f.message, /WHITE-2026-001/);
  assert.match(f.message, /Updating the library is not enough/);
});

test('a blocked version can be allowed with a reason, and the exception expires', () => {
  const blocked = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', reason: 'broken' } : m));
  const p = metaProject({ manifests: blocked });
  const allowed = analyze(p, { protocols: { allow: [{ protocol: 'meta@2.0', reason: 'migrating in Q1', until: '2999-01-01' }] } });
  assert.equal(allowed.summary.error + allowed.summary.critical, 0);
  assert.ok(allowed.findings.some((f) => f.code === 'blocked-allowed' && f.allowed && /migrating in Q1/.test(f.message)));
  const expired = analyze(p, { protocols: { allow: [{ protocol: 'meta@2.0', reason: 'old', until: '2000-01-01' }] } });
  assert.ok(codes(expired, 'error').includes('blocked-version'));
  assert.ok(codes(expired).includes('exception-expired'));
  assert.throws(() => resolveConfig({ protocols: { allow: [{ protocol: 'meta@2.0' }] } }), /written "reason"/);
});

test('projects can block a version themselves', () => {
  const r = analyze(metaProject(), { protocols: { block: ['meta@2.0'] } });
  assert.ok(codes(r, 'error').includes('blocked-version'));
});

test('a removed version is an error', () => {
  const p = metaProject({ manifests: protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'removed' } : m)) });
  assert.ok(codes(analyze(p), 'error').includes('removed-version'));
});

test('a protocol version nobody implements is reported', () => {
  const p = metaProject();
  installPackage(p, 'white-meta', { version: '1.0.0', white: { provides: { meta: ['3.0'] }, defines: protocolManifests(), migrations: './migrations.js' } }, { 'migrations.js': '' });
  const r = analyze(p);
  const missing = r.findings.filter((f) => f.code === 'implementation-missing');
  assert.deepEqual(missing.map((f) => `${f.subject} ${f.version}`).sort(), ['white-auth 2.0', 'white-cache 2.0']);
  assert.throws(() => enforce(r.findings), /meta@2.0, but no installed package implements it/);
});

test('an unknown protocol, and an unknown version of a known one', () => {
  const p = metaProject();
  installPackage(p, 'white-auth', { version: '2.4.0', white: { protocols: { meta: { required: '9.9' }, ghost: { required: '1.0' }, soft: { required: '1.0', optional: true } } } });
  const r = analyze(p);
  assert.ok(codes(r, 'error').includes('version-unknown'));
  assert.equal(r.findings.filter((f) => f.code === 'protocol-unknown').map((f) => f.severity).sort().join(), 'error,warning');
});

test('the selection file switches one library explicitly; unsupported selections are errors', () => {
  const p = metaProject();
  p.write('white.protocols.json', { version: 1, libraries: { 'white-auth': { meta: '3.0' } } });
  const r = analyze(p);
  assert.equal(r.users.find((u) => u.subject === 'white-auth').version, '3.0');
  assert.equal(r.users.find((u) => u.subject === 'white-cache').version, '2.0', 'others are not switched implicitly');
  p.write('white.protocols.json', { version: 1, libraries: { 'white-cache': { meta: '3.0' } } });
  assert.ok(codes(analyze(p), 'error').includes('selection-unsupported'));
});

test('single-generation protocols: mixed generations warn when a common one exists, conflict when none', () => {
  const single = protocolManifests().map((m) => ({ ...m, coexistence: 'single' }));
  const p = metaProject({ manifests: single });
  installPackage(p, 'white-mesh', { version: '3.1.0', white: { protocols: { meta: { required: '3.0', supported: ['3.0'] } } } });
  const conflict = analyze(p);
  assert.ok(codes(conflict, 'error').includes('generation-conflict'), 'white-cache supports only 2.0, white-mesh only 3.0');
  installPackage(p, 'white-cache', { version: '1.3.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } } });
  installPackage(p, 'white-mesh', { version: '3.1.0', white: { protocols: { meta: { required: '3.0', supported: ['2.0', '3.0'] } } } });
  const mismatch = analyze(p);
  assert.ok(codes(mismatch, 'warning').includes('generation-mismatch'));
  assert.match(mismatch.findings.find((f) => f.code === 'generation-mismatch').hint, /meta@3\.0/);
});

test('definitions from two packages that disagree are reported', () => {
  const p = metaProject();
  installPackage(p, 'white-other', { white: { defines: [{ name: 'meta', version: '3.0', status: 'supported' }] } });
  p.write('package.json', { name: 'app', dependencies: { 'white-meta': '*', 'white-other': '*', 'white-auth': '*' } });
  assert.ok(analyze(p).findings.some((f) => f.code === 'registry-invalid' && /defined twice/.test(f.message)));
});

test('libraries without a "white" field are ignored', () => {
  const p = tmpProject({ 'package.json': { name: 'app', dependencies: { express: '*' } } });
  installPackage(p, 'express', {});
  const r = analyze(p);
  assert.equal(r.status, 'OK');
  assert.equal(r.users.length, 0);
});

// ── In the running app ──

test('createApp refuses to start when a protocol in use is blocked, and plugins never ran', async () => {
  const blocked = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', advisory: { id: 'X-1', severity: 'critical', summary: 'bad' } } : m));
  const p = metaProject({ manifests: blocked });
  let ran = false;
  await assert.rejects(createTestClient({ plugins: [() => { ran = true; }] }, { root: p.root }), (e) => e instanceof ProtocolError && /blocked/.test(e.message) && /white migrate/.test(e.hint));
  assert.equal(ran, false);
  const ok = await createTestClient({ protocols: { enforce: 'off' } }, { root: p.root });
  await ok.close();
});

test('ctx.protocols exposes the registry and fixes what each library uses', async () => {
  const p = metaProject();
  const client = await createTestClient({}, { root: p.root });
  const { protocols } = client.ctx;
  assert.equal(protocols.registry.frozen, true);
  assert.equal(protocols.for('white-auth').version('meta'), '2.0');
  assert.equal(protocols.for('white-auth').version('meta'), '2.0', 'the same answer every time');
  assert.equal(protocols.supports('meta', '3.0'), true);
  assert.equal(protocols.supports('meta', '9.0'), false);
  assert.throws(() => protocols.for('express'), ProtocolError);
  assert.throws(() => protocols.registry.register(manifest({ version: '5.0' })), /frozen/);
  assert.equal(Object.isFrozen(protocols), true);
  await client.close();
});

test('the mesh manifest tells peers which protocols and fingerprint a service has', async () => {
  const c = await createTestClient();
  assert.deepEqual(c.ctx.protocols.used.mesh, ['1.0']);
  assert.match(c.ctx.protocols.fingerprint, /^[0-9a-f]{16}$/);
  await c.close();
});

test('a plugin package that declares a blocked protocol is refused before its code runs', async () => {
  const p = tmpProject({ 'package.json': { name: 'app', type: 'module' } });
  installPackage(p, 'white-meta', { white: { provides: { meta: ['1.0'] }, defines: [{ name: 'meta', version: '1.0', status: 'blocked', reason: 'broken' }] } });
  installPackage(p, 'white-plugin-x', { type: 'module', main: 'index.js', white: { protocols: { meta: { required: '1.0' } } } }, { 'index.js': 'globalThis.__ran = true; export default () => {};' });
  p.write('package.json', { name: 'app', type: 'module', dependencies: { 'white-meta': '*' } }); // the plugin itself is not a listed dependency
  delete globalThis.__ran;
  await assert.rejects(createTestClient({ plugins: ['white-plugin-x'] }, { root: p.root }), /blocked/);
  assert.equal(globalThis.__ran, undefined, 'the plugin module was not imported');
});
