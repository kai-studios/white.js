import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metaProject, protocolManifests } from './helpers/meta.js';
import { installPackage } from './helpers/project.js';

const bin = fileURLToPath(new URL('../bin/white.js', import.meta.url));
const white = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1', LOG_LEVEL: 'silent' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const unblocked = (opts) => {
  const p = metaProject(opts);
  installPackage(p, 'white-cache', { version: '1.3.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } } });
  return p;
};
const snapshot = (root) => {
  const out = {};
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (out[path.relative(root, path.join(d, e.name))] = fs.readFileSync(path.join(d, e.name), 'utf8'))));
  walk(root);
  return out;
};

// ── doctor ──

test('doctor shows the protocol section in the documented layout and exits 0 on warnings', () => {
  const p = metaProject();
  const { code, out } = white(p.root, 'doctor');
  assert.equal(code, 0);
  assert.match(out, /White\.js Doctor/);
  assert.match(out, /Protocol Compatibility/);
  assert.match(out, /META\n\s+meta@3\.0\s+CURRENT\n\s+meta@2\.0\s+DEPRECATED/);
  assert.match(out, /Detected:\n\s+2 libraries use a legacy protocol\./);
  assert.match(out, /white-auth\s+meta@2\.0/);
  assert.match(out, /Recommendations:\n\s+white-auth\s+(→|->) meta@3\.0/);
  assert.match(out, /Migration available:\n\s+1 automatic\n\s+0 manual/);
  assert.match(out, /Status: WARNING/);
});

test('doctor never changes the project', () => {
  const p = metaProject();
  const before = snapshot(p.root);
  white(p.root, 'doctor');
  white(p.root, 'doctor', '--json');
  assert.deepEqual(snapshot(p.root), before);
});

test('doctor does not run plugins or routes unless --deep is given', () => {
  const marker = path.join(metaProject().root, '..', `ran-${process.pid}.txt`);
  const p = metaProject({
    config: `import fs from 'node:fs';\nexport default { plugins: ['./plugin.js'] };\n`,
    files: { 'plugin.js': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\nexport default () => {};\n` },
  });
  const plain = white(p.root, 'doctor');
  assert.equal(fs.existsSync(marker), false, 'the plugin was not imported');
  assert.match(plain.out, /plugin: \.\/plugin\.js/);
  const deep = white(p.root, 'doctor', '--deep');
  assert.equal(fs.existsSync(marker), true, '--deep loads the app');
  assert.match(deep.out, /deep check/i);
  fs.rmSync(marker, { force: true });
});

test('doctor exit codes: 1 for errors, 2 for critical security problems, --strict makes warnings fail', () => {
  const blocked = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', advisory: { id: 'SEC-9', severity: 'critical', summary: 'forged signatures' } } : m));
  const crit = white(metaProject({ manifests: blocked }).root, 'doctor');
  assert.equal(crit.code, 2);
  assert.match(crit.out, /SEC-9/);
  assert.match(crit.out, /Status: CRITICAL/);

  const removed = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'removed' } : m));
  assert.equal(white(metaProject({ manifests: removed }).root, 'doctor').code, 1);

  const warn = metaProject();
  assert.equal(white(warn.root, 'doctor').code, 0);
  assert.equal(white(warn.root, 'doctor', '--strict').code, 1);
});

test('doctor --json is machine readable', () => {
  const { out, code } = white(metaProject().root, 'doctor', '--json');
  const data = JSON.parse(out);
  assert.equal(code, 0);
  assert.equal(data.status, 'WARNING');
  assert.ok(data.protocols.findings.some((f) => f.code === 'deprecated-version'));
  assert.ok(data.registry.protocols.some((x) => x.name === 'meta'));
});

test('doctor finds loader problems without running anything', () => {
  const p = metaProject({
    config: `export default { plugins: ['not-installed', './missing.js', 42] };\n`,
    files: { 'server/routes/admin/x.js': 'export default () => {};', 'server/routes/client/[1x].js': '', 'server/routes/client/[id].js': '', 'server/routes/client/profile.js': '' },
  });
  const { out, code } = white(p.root, 'doctor');
  assert.equal(code, 1);
  assert.match(out, /unknown route group/);
  assert.match(out, /invalid route file/);
  assert.match(out, /not-installed[\s\S]*npm install not-installed/);
  assert.match(out, /\.\/missing\.js/);
  assert.match(out, /invalid plugin declaration/);
  assert.match(out, /\/profile and \/:id can match the same URL/);
});

test('doctor reports an unsafe trustProxy as a configuration error', () => {
  const p = metaProject({ config: 'export default { trustProxy: true };\n' });
  const { out, code } = white(p.root, 'doctor');
  assert.equal(code, 1);
  assert.match(out, /forge its IP/);
});

// ── protocol ──

test('protocol list / info', () => {
  const p = metaProject();
  const list = white(p.root, 'protocol', 'list');
  assert.equal(list.code, 0);
  assert.match(list.out, /meta@2\.0\s+DEPRECATED\s+used by white-auth, white-cache/);
  assert.match(list.out, /mesh@1\.0\s+CURRENT/);
  const info = white(p.root, 'protocol', 'info', 'meta@3.0');
  assert.match(info.out, /replaces\s+meta@2\.0/);
  assert.match(info.out, /migration\s+meta@2\.0 → meta@3\.0, automatic \(meta-2\.0-to-3\.0\)/);
  assert.match(white(p.root, 'protocol', 'info', 'meta').out, /meta@3\.0[\s\S]*meta@2\.0/);
  const json = JSON.parse(white(p.root, 'protocol', 'info', 'meta@2.0', '--json').out);
  assert.equal(json[0].status, 'deprecated');
});

test('protocol: unknown names explain themselves and exit 1; integrity prints the hash for manifests', () => {
  const p = metaProject();
  const unknown = white(p.root, 'protocol', 'info', 'nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown protocol "nope"[\s\S]*Known protocols: mesh, meta, plugin/);
  assert.equal(white(p.root, 'protocol', 'info', 'meta@9.9').code, 1);
  assert.equal(white(p.root, 'protocol').code, 0);
  assert.equal(white(p.root, 'protocol', 'wat').code, 1);
  const hash = white(p.root, 'protocol', 'integrity', 'node_modules/white-meta/migrations.js');
  assert.match(hash.out.trim(), /^sha256-[A-Za-z0-9+/]{43}=$/);
});

// ── migrate ──

test('migrate --analyze explains the plan and changes nothing', () => {
  const p = unblocked();
  const before = snapshot(p.root);
  const { out, code } = white(p.root, 'migrate', 'meta@3.0', '--analyze');
  assert.equal(code, 0);
  assert.match(out, /server\/hooks\.js/);
  assert.match(out, /-export const tags = meta\.tags;/);
  assert.match(out, /Analysis only/);
  assert.deepEqual(snapshot(p.root), before);
});

test('migrate explains why it cannot proceed and exits 1', () => {
  const { out, code } = white(metaProject().root, 'migrate', 'meta@3.0');
  assert.equal(code, 1);
  assert.match(out, /Cannot migrate/);
  assert.match(out, /white-cache@1\.2\.0 supports meta 2\.0 but not 3\.0/);
});

test('migrate without a terminal and without --yes changes nothing', () => {
  const p = unblocked();
  const before = snapshot(p.root);
  const r = white(p.root, 'migrate', 'meta@3.0');
  assert.equal(r.code, 1);
  assert.match(r.err, /Re-run with --yes/);
  assert.deepEqual(snapshot(p.root), before);
});

test('migrate --yes applies, then a second run does nothing; doctor agrees', () => {
  const p = unblocked();
  const first = white(p.root, 'migrate', 'meta@3.0', '--yes');
  assert.equal(first.code, 0);
  assert.match(first.out, /Migrated meta-2\.0-to-3\.0/);
  assert.equal(p.read('server/hooks.js'), 'export const tags = meta.labels;\n');
  const second = white(p.root, 'migrate', 'meta@3.0', '--yes');
  assert.equal(second.code, 0);
  assert.match(second.out, /Nothing to migrate/);
  const doctor = white(p.root, 'doctor');
  assert.match(doctor.out, /all protocol versions in use are supported/);
  assert.match(doctor.out, /1 migration applied/);
});

test('migrate --manual prints instructions, writes only to --out, and never edits the project', () => {
  const p = unblocked();
  const before = snapshot(p.root);
  const guide = white(p.root, 'migrate', 'meta@3.0', '--manual');
  assert.equal(guide.code, 0);
  assert.match(guide.out, /# Migration guide: meta@3\.0/);
  assert.match(guide.out, /Edit `server\/hooks\.js`/);
  assert.deepEqual(snapshot(p.root), before);
  const out = path.join(p.root, '..', `guide-${process.pid}.md`);
  white(p.root, 'migrate', 'meta@3.0', '--manual', '--out', out);
  assert.match(fs.readFileSync(out, 'utf8'), /Migration guide/);
  fs.rmSync(out);
});

test('migrate: usage errors are readable and exit 1', () => {
  const p = unblocked();
  for (const args of [['--analyze', '--manual'], ['--wat'], ['a@1.0', 'b@1.0'], ['nonsense']]) {
    const r = white(p.root, 'migrate', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.doesNotMatch(r.err, /at .*\.js:\d+/, 'no stack trace');
  }
});

test('migrate --recover repairs an interrupted run', () => {
  const p = unblocked();
  p.write('.white/migrations/x/journal.json', { runId: 'x', state: 'applying', files: [{ file: 'server/hooks.js', kind: 'edit' }] });
  p.write('.white/migrations/x/backup/server/hooks.js', 'ORIGINAL\n');
  assert.equal(white(p.root, 'migrate', 'meta@3.0', '--yes').code, 1);
  const r = white(p.root, 'migrate', '--recover');
  assert.equal(r.code, 0);
  assert.equal(p.read('server/hooks.js'), 'ORIGINAL\n');
  assert.equal(white(p.root, 'migrate', 'meta@3.0', '--analyze').code, 0);
});

test('migrate with a blocked protocol and no target plans the forced migration', () => {
  const blocked = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', advisory: { id: 'SEC-9', severity: 'critical', summary: 'forged signatures' } } : m));
  const p = metaProject({ manifests: blocked });
  installPackage(p, 'white-cache', { version: '1.3.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } } });
  const r = white(p.root, 'migrate', '--analyze');
  assert.equal(r.code, 0);
  assert.match(r.out, /required: blocked or removed versions/);
  assert.match(r.out, /meta@3\.0/);
  assert.equal(white(p.root, 'migrate', '--yes').code, 0);
  assert.equal(white(p.root, 'doctor').code, 0, 'after the forced migration the blocked version is gone');
});
