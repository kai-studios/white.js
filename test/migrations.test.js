import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig, MigrationError } from '../src/index.js';
import { createMigrationEngine } from '../src/migrations/engine.js';
import { defineMigration } from '../src/migrations/kit.js';
import { unifiedDiff, integrityOf } from '../src/migrations/diff.js';
import { LEDGER_FILE, acquireLock } from '../src/migrations/store.js';
import { metaProject, MIGRATION_SOURCE, protocolManifests } from './helpers/meta.js';
import { installPackage } from './helpers/project.js';

const engineFor = (p, config = {}) => createMigrationEngine({ root: p.root, config: resolveConfig(config) });
// a project whose only blocker (white-cache cannot do meta 3.0) is gone
const ready = (opts = {}) => {
  const p = metaProject(opts);
  installPackage(p, 'white-cache', { version: '1.3.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } } });
  return p;
};
const snapshot = (p) => {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(p.root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(p.root);
  return out;
};

test('defineMigration validates what a protocol author writes', () => {
  assert.throws(() => defineMigration({ id: 'x', protocol: 'meta', from: '2.0', to: 'three', plan() {} }), MigrationError);
  assert.throws(() => defineMigration({ id: 'ok-id', protocol: 'meta', from: '2.0', to: '3.0' }), /plan/);
  assert.equal(Object.isFrozen(defineMigration({ id: 'ok-id', protocol: 'meta', from: '2.0', to: '3.0', plan() {} })), true);
});

test('Analysis describes the migration and changes nothing on disk', async () => {
  const p = ready();
  const before = snapshot(p);
  const plan = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.deepEqual(snapshot(p), before, 'not a single file was created or changed (no .white/, no lock)');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.files.map((f) => f.file).sort(), ['server/hooks.js', 'white.protocols.json']);
  assert.match(plan.files.find((f) => f.file === 'server/hooks.js').diff, /-export const tags = meta\.tags;\n\+export const tags = meta\.labels;/);
  assert.deepEqual(plan.users.filter((u) => u.state === 'pending').map((u) => u.subject).sort(), ['white-auth', 'white-cache']);
  assert.equal(plan.users.find((u) => u.subject === 'white-mesh').state, 'already');
  assert.equal(plan.steps[0].origin, 'white-meta');
});

test('a library that cannot speak the target blocks the plan, with the reason', async () => {
  const plan = await engineFor(metaProject()).plan({ target: 'meta@3.0' });
  assert.equal(plan.canApply, false);
  assert.match(plan.blockers[0].message, /white-cache@1\.2\.0 supports meta 2\.0 but not 3\.0/);
  assert.match(plan.blockers[0].message, /outside "white migrate"/);
});

test('automatic migration: backup, write, verify, ledger; the generation is recorded explicitly', async () => {
  const p = ready();
  const engine = engineFor(p);
  const stages = [];
  const result = await engine.apply(await engine.plan({ target: 'meta@3.0' }), { onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['checking', 'backing up', 'writing', 'verifying']);
  assert.equal(p.read('server/hooks.js'), 'export const tags = meta.labels;\n');
  assert.deepEqual(JSON.parse(p.read('white.protocols.json')), { version: 1, use: {}, libraries: { 'white-auth': { meta: '3.0' }, 'white-cache': { meta: '3.0' } } });
  const ledger = JSON.parse(p.read(LEDGER_FILE));
  assert.equal(ledger.applied[0].id, 'meta-2.0-to-3.0');
  assert.equal(ledger.applied[0].runId, result.runId);
  const journal = JSON.parse(p.read(`.white/migrations/${result.runId}/journal.json`));
  assert.equal(journal.state, 'done');
  assert.equal(p.read(`.white/migrations/${result.runId}/backup/server/hooks.js`), 'export const tags = meta.tags;\n', 'the original is kept');
  assert.equal(p.exists('.white/migrate.lock'), false, 'the lock is released');
  // the doctor's view now agrees
  const after = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.equal(after.upToDate, true);
  assert.equal(engine.state.report.users.every((u) => u.version === '3.0'), true);
});

test('running the same migration again changes nothing (idempotent, and recorded)', async () => {
  const p = ready();
  const engine = engineFor(p);
  await engine.apply(await engine.plan({ target: 'meta@3.0' }));
  const before = snapshot(p);
  const again = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.equal(again.canApply, false);
  assert.equal(again.files.length, 0);
  assert.equal(again.upToDate, true);
  assert.deepEqual(snapshot(p), before);
});

test('a plan that was already applied cannot be applied again', async () => {
  const p = ready();
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  await engine.apply(plan);
  await assert.rejects(engine.apply(plan), (e) => e instanceof MigrationError && ['MIGRATION_STALE', 'MIGRATION_ALREADY_APPLIED'].includes(e.code));
  assert.equal(JSON.parse(p.read(LEDGER_FILE)).applied.length, 1);
});

test('a plan is refused when files changed after it was made', async () => {
  const p = ready();
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  p.write('server/hooks.js', 'export const tags = meta.tags; // edited meanwhile\n');
  await assert.rejects(engine.apply(plan), (e) => e.code === 'MIGRATION_STALE' && /changed after the plan/.test(e.message));
  assert.equal(p.exists('white.protocols.json'), false);
  assert.equal(p.exists(LEDGER_FILE), false);
});

test('manual actions are reported next to the automatic ones, and survive a re-run', async () => {
  const p = ready({ files: { 'server/legacy.js': 'meta.legacyHook(() => {});\n' } });
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  assert.deepEqual(plan.manual.map((m) => [m.file, m.message]), [['server/legacy.js', 'meta.legacyHook was removed']]);
  const result = await engine.apply(plan);
  assert.equal(result.manual.length, 1);
  const rerun = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.equal(rerun.manual.length, 1, 'still listed until the developer fixes it');
  assert.equal(rerun.files.length, 0);
  assert.equal(rerun.upToDate, false);
  assert.match(engine.manualGuide(rerun), /meta\.legacyHook was removed[\s\S]*meta\.on\("change"\)/);
});

test('manual mode produces step-by-step instructions including the diffs', async () => {
  const p = ready();
  const engine = engineFor(p);
  const guide = engine.manualGuide(await engine.plan({ target: 'meta@3.0' }));
  assert.match(guide, /# Migration guide: meta@3\.0/);
  assert.match(guide, /Edit `server\/hooks\.js`/);
  assert.match(guide, /```diff[\s\S]*\+export const tags = meta\.labels;/);
  assert.match(guide, /white\.protocols\.json/);
});

test('a failing verify() restores every file', async () => {
  const bad = MIGRATION_SOURCE.replace("text.replaceAll('meta.tags', 'meta.labels')", "text.replaceAll('meta.tags', 'meta.tagz')").replace("includes('meta.tags')) return", "includes('meta.tagz')) return");
  const p = ready({ migrationSource: bad, manifests: protocolManifests({ migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(bad) } }) });
  const before = snapshot(p);
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  await assert.rejects(engine.apply(plan), (e) => e.rolledBack === true && /Verification failed/.test(e.message) && /No changes were kept/.test(e.message));
  const after = snapshot(p);
  for (const f of ['server/hooks.js', 'package.json']) assert.equal(after[f], before[f]);
  assert.equal(p.exists('white.protocols.json'), false, 'the created file is removed again');
  assert.equal(p.exists(LEDGER_FILE), false, 'a failed run is not recorded as applied');
  const [journal] = fs.readdirSync(path.join(p.root, '.white/migrations')).map((d) => JSON.parse(p.read(`.white/migrations/${d}/journal.json`)));
  assert.equal(journal.state, 'rolled-back');
  assert.equal(p.exists('.white/migrate.lock'), false);
});

test('a write that fails half way (partial application) is rolled back', async () => {
  const p = ready({ files: { 'server/a.js': 'meta.tags;\n', 'server/b.js': 'meta.tags;\n' } });
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  // make the second write fail: a directory sits where the file would be replaced
  const victim = plan.files.map((f) => f.file).sort().at(-1);
  const before = snapshot(p);
  const realRename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (a, b) => {
    if (String(b).endsWith(victim) && calls++ === 0) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return realRename(a, b);
  };
  try {
    await assert.rejects(engine.apply(plan), /disk full/);
  } finally {
    fs.promises.rename = realRename;
  }
  const after = snapshot(p);
  for (const f of Object.keys(before)) if (!f.startsWith('.white/')) assert.equal(after[f], before[f], f);
  assert.equal(p.exists('white.protocols.json'), false);
});

test('an interrupted run blocks new ones until it is recovered', async () => {
  const p = ready();
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  // simulate a crash: journal says "applying", one file already rewritten, no rollback happened
  const runId = 'crashed-run';
  p.write(`.white/migrations/${runId}/journal.json`, { runId, state: 'applying', files: [{ file: 'server/hooks.js', kind: 'edit' }, { file: 'white.protocols.json', kind: 'create' }] });
  p.write(`.white/migrations/${runId}/backup/server/hooks.js`, 'export const tags = meta.tags;\n');
  p.write('server/hooks.js', 'export const tags = meta.labels;\n');
  p.write('white.protocols.json', '{}');
  const blocked = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.equal(blocked.canApply, false);
  assert.match(blocked.blockers[0].message, /interrupted[\s\S]*white migrate --recover/);
  await assert.rejects(engine.apply(plan), /interrupted/);
  const { recovered } = await engineFor(p).recover();
  assert.equal(recovered[0].runId, runId);
  assert.equal(p.read('server/hooks.js'), 'export const tags = meta.tags;\n');
  assert.equal(p.exists('white.protocols.json'), false);
  assert.equal((await engineFor(p).recover()).recovered.length, 0, 'recovering twice is harmless');
  assert.equal((await engineFor(p).plan({ target: 'meta@3.0' })).canApply, true);
});

test('only one migration runs at a time', async () => {
  const p = ready();
  const release = await acquireLock(p.root);
  const engine = engineFor(p);
  await assert.rejects(engine.apply(await engine.plan({ target: 'meta@3.0' })), (e) => e.code === 'MIGRATION_LOCKED');
  await release();
  fs.writeFileSync(path.join(p.root, '.white/migrate.lock'), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'long ago' }));
  await (await acquireLock(p.root))(); // a lock left by a dead process is taken over
});

test('provenance and integrity: a tampered or unverified migration module never runs', async () => {
  const p = ready();
  fs.appendFileSync(path.join(p.root, 'node_modules/white-meta/migrations.js'), '\n// tampered\n');
  const plan = await engineFor(p).plan({ target: 'meta@3.0' });
  assert.equal(plan.canApply, false);
  assert.match(plan.blockers[0].message, /does not match the integrity/);

  const noIntegrity = ready({ manifests: protocolManifests({ migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0' } }) });
  const unverified = await engineFor(noIntegrity).plan({ target: 'meta@3.0' });
  assert.match(unverified.blockers[0].message, /no "migration\.integrity"/);
  assert.equal(unverified.steps[0].code, 'unverified');
});

test('a module that claims to migrate something else is rejected', async () => {
  const liar = MIGRATION_SOURCE.replace("to: '3.0'", "to: '4.0'");
  const p = ready({ migrationSource: liar, manifests: protocolManifests({ migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(liar) } }) });
  assert.match((await engineFor(p).plan({ target: 'meta@3.0' })).blockers[0].message, /claims to migrate/);
});

test('an unsafe operation (outside the project, package.json, delete) is rejected', async () => {
  for (const [what, op] of [
    ["project.edit('../outside.js', 'x')", /outside the project/],
    ["project.edit('package.json', '{}')", /do not change dependencies/],
    ["{ kind: 'delete', file: 'server/hooks.js' }", /never delete/],
    ["project.create('server/hooks.js', 'x')", /already exists/],
    ["project.edit('server/nope.js', 'x')", /does not exist/],
  ]) {
    const src = `export default { id: 'meta-2.0-to-3.0', protocol: 'meta', from: '2.0', to: '3.0', async plan(project) { return { operations: [${what}] }; } };`;
    const p = ready({ migrationSource: src, manifests: protocolManifests({ migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(src) } }) });
    let message;
    try {
      message = (await engineFor(p).plan({ target: 'meta@3.0' })).blockers.map((b) => b.message).join(' ');
    } catch (e) {
      message = e.message;
    }
    assert.match(message, op, what);
  }
});

test('a migration that would wipe most of a file needs explicit confirmation', async () => {
  const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const src = `export default { id: 'meta-2.0-to-3.0', protocol: 'meta', from: '2.0', to: '3.0', async plan(project) { return { operations: [project.edit('server/big.js', '// gone\\n')] }; } };`;
  const p = ready({ files: { 'server/big.js': big }, migrationSource: src, manifests: protocolManifests({ migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(src) } }) });
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@3.0' });
  assert.equal(plan.files.find((f) => f.file === 'server/big.js').destructive, true);
  await assert.rejects(engine.apply(plan), (e) => e.code === 'MIGRATION_DESTRUCTIVE');
  assert.equal(p.read('server/big.js'), big);
  await engine.apply(plan, { allowDestructive: true });
  assert.equal(p.read('server/big.js'), '// gone\n');
});

test('no path, unknown target, and nothing-to-do are explained', async () => {
  const p = ready();
  assert.match((await engineFor(p).plan({ target: 'meta@9.0' })).blockers[0].message, /not registered/);
  await assert.rejects(engineFor(p).plan({ target: 'nonsense' }), /not a protocol version/);
  const noPath = ready({ manifests: protocolManifests().map(({ migration, ...rest }) => rest) });
  assert.match((await engineFor(noPath).plan({ target: 'meta@3.0' })).blockers[0].message, /No migration is declared from meta@2\.0/);
  const none = await engineFor(p).plan();
  assert.equal(none.mandatory, true);
  assert.match(none.notes[0], /nothing has to be migrated/);
});

test('with no target, the migrations forced by a blocked version are planned', async () => {
  const blocked = protocolManifests().map((m) => (m.version === '2.0' ? { ...m, status: 'blocked', advisory: { id: 'SEC-1', severity: 'critical', summary: 'bad' } } : m));
  const p = ready({ manifests: blocked });
  const plan = await engineFor(p, { protocols: { enforce: 'off' } }).plan();
  assert.deepEqual(plan.targets, ['meta@3.0']);
  assert.equal(plan.canApply, true);
});

test('chained migrations see the result of the previous hop', async () => {
  const hop1 = `export default [{ id: 'meta-2.0-to-3.0', protocol: 'meta', from: '2.0', to: '3.0', async plan(p) { const t = await p.read('server/hooks.js'); return { operations: [p.edit('server/hooks.js', t.replace('tags', 'labels'), 'hop1')] }; } }, { id: 'meta-3.0-to-4.0', protocol: 'meta', from: '3.0', to: '4.0', async plan(p) { const t = await p.read('server/hooks.js'); return { operations: [p.edit('server/hooks.js', t.replace('labels', 'topics'), 'hop2')] }; } }];`;
  const manifests = [
    { name: 'meta', version: '2.0', status: 'deprecated' },
    { name: 'meta', version: '3.0', status: 'supported', migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(hop1) } },
    { name: 'meta', version: '4.0', status: 'current', migration: { from: 'meta@3.0', to: 'meta@4.0', strategy: 'automatic', id: 'meta-3.0-to-4.0', integrity: integrityOf(hop1) } },
  ];
  const p = ready({ migrationSource: hop1, manifests });
  for (const lib of ['white-auth', 'white-cache']) installPackage(p, lib, { version: '9.0.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0', '4.0'] } } } });
  installPackage(p, 'white-mesh', { version: '9.0.0', white: { protocols: { meta: { required: '3.0', supported: ['3.0', '4.0'] } } } });
  installPackage(p, 'white-meta', { white: { provides: { meta: ['2.0', '3.0', '4.0'] }, defines: manifests, migrations: './migrations.js' } }, { 'migrations.js': hop1 });
  const engine = engineFor(p);
  const plan = await engine.plan({ target: 'meta@4.0' });
  assert.deepEqual(plan.steps.map((s) => s.id), ['meta-2.0-to-3.0', 'meta-3.0-to-4.0']);
  await engine.apply(plan);
  assert.equal(p.read('server/hooks.js'), 'export const topics = meta.tags;\n'.replace('topics = meta.tags', 'topics = meta.tags'));
});

test('diffs are unified and show context', () => {
  const d = unifiedDiff('a.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n');
  assert.match(d, /^--- a\/a\.js\n\+\+\+ b\/a\.js\n@@ -1,7 \+1,7 @@/);
  assert.match(d, /-four\n\+FOUR/);
  assert.equal(unifiedDiff('a.js', 'same\n', 'same\n'), '');
  assert.match(unifiedDiff('new.js', null, 'x\n'), /--- \/dev\/null/);
});
