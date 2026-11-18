import fs from 'node:fs/promises';
import path from 'node:path';
import { MigrationError } from '../core/white-error.js';
import { loadProtocolState, SELECTION_FILE } from '../protocols/index.js';
import { tryParseRef, compareProtocolVersions } from '../protocols/version.js';
import { createProjectView, safePath, MAX_FILE } from './project.js';
import { findMigration } from './providers.js';
import { sha256, unifiedDiff, diffStats } from './diff.js';
import { acquireLock, appendLedger, backupFile, incompleteRuns, newRunId, readLedger, restoreRun, runDir, writeAtomic, writeJournal } from './store.js';
import { version as frameworkVersion } from '../core/meta.js';

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const serializeSelection = (s) =>
  JSON.stringify({ version: 1, use: sortKeys(s.use), libraries: sortKeys(Object.fromEntries(Object.entries(s.libraries).filter(([, m]) => Object.keys(m).length).map(([k, m]) => [k, sortKeys(m)]))) }, null, 2) + '\n';

const nonBlank = (text) => text.split('\n').filter((l) => l.trim()).length;

// The Migration Engine. Three things, kept apart:
//   plan(target)         Analysis. Reads the project and describes the migration. Writes NOTHING (no
//                        files, no lock, no .white/ folder). Everything the CLI shows comes from here.
//   apply(plan)          Automatic migration. Re-checks the plan against the files, takes the lock,
//                        journals and backs up, writes, verifies, records in the ledger, or rolls back.
//   manualGuide(plan)    Instructions for a developer who does the changes by hand.
export function createMigrationEngine({ root, config, state: initial, now = () => new Date() }) {
  let state = initial ?? loadProtocolState(config, root);
  const reload = () => (state = loadProtocolState(config, root));

  // ── Analysis ──────────────────────────────────────────────────────────

  function targetsFor(ref) {
    const { registry, report } = state;
    if (ref) {
      const parsed = tryParseRef(ref);
      if (!parsed) throw new MigrationError(`"${ref}" is not a protocol version. Use name@MAJOR.MINOR, for example meta@3.0`);
      return { targets: [parsed], mandatory: false };
    }
    // no target: the migrations that cannot wait, i.e. protocols used in a blocked or removed version
    const targets = [];
    for (const protocol of new Set(report.users.map((u) => u.protocol))) {
      const bad = report.users.some((u) => ['blocked', 'removed'].includes(registry.statusOf(u.protocol, u.version)) && u.protocol === protocol);
      const current = registry.current(protocol);
      if (bad && current) targets.push({ name: protocol, version: current.version, id: `${protocol}@${current.version}` });
    }
    return { targets, mandatory: true };
  }

  async function plan({ target } = {}) {
    reload();
    const { registry, report, scan, selection } = state;
    const { targets, mandatory } = targetsFor(target);
    const ledger = await readLedger(root);
    const appliedIds = new Set(ledger.applied.map((a) => a.id));

    const result = {
      target: target ?? null,
      mandatory,
      targets: targets.map((t) => t.id ?? `${t.name}@${t.version}`),
      steps: [],
      users: [],
      blockers: [],
      manual: [],
      notes: [],
      operations: [],
      files: [],
      interrupted: (await incompleteRuns(root)).map((r) => r.runId),
    };
    if (result.interrupted.length) result.blockers.push({ message: `An earlier migration run was interrupted (${result.interrupted.join(', ')}). Restore the project first with: white migrate --recover` });
    if (mandatory && !targets.length) result.notes.push('No protocol is used in a blocked or removed version: nothing has to be migrated.');

    const overlay = new Map();
    const original = new Map(); // file -> original text (null: did not exist)
    const newSelection = structuredClone(selection);
    const reasons = new Map();

    const view = () => createProjectView({ root, config, overlay, protocols: Object.freeze({ selection: structuredClone(selection), users: report.users.map((u) => ({ ...u })) }) });

    for (const t of targets) {
      const protocol = t.name;
      const manifest = registry.get(protocol, t.version);
      const ref = `${protocol}@${t.version}`;
      if (!manifest) {
        result.blockers.push({ message: `${ref} is not registered. Known versions of ${protocol}: ${registry.versions(protocol).map((m) => m.version).join(', ') || 'none (is the package that defines it installed?)'}` });
        continue;
      }
      const judged = state.engine.judge('target', protocol, t.version).filter((f) => ['error', 'critical'].includes(f.severity) && !f.allowed);
      for (const f of judged) result.blockers.push({ message: `Target ${ref} cannot be used: ${f.message}` });
      if (judged.length) continue;

      const users = report.users.filter((u) => u.protocol === protocol);
      if (!users.length) result.notes.push(`Nothing in this project uses ${protocol}.`);
      const hops = new Map(); // edge id -> edge

      for (const u of users) {
        const row = { subject: u.subject, kind: u.kind, protocol, from: u.version, to: t.version };
        result.users.push(row);
        if (u.version === t.version) {
          row.state = 'already';
          continue;
        }
        if (u.kind === 'library' && !u.supported.includes(t.version)) {
          row.state = 'blocked';
          result.blockers.push({ message: `${u.subject}@${u.libraryVersion} supports ${protocol} ${u.supported.join(', ')} but not ${t.version}. Update ${u.subject} to a release that supports ${ref} (npm update is outside "white migrate"), then run this again` });
          continue;
        }
        const route = registry.pathTo(protocol, u.version, t.version);
        if (!route) {
          row.state = 'blocked';
          result.blockers.push({ message: `No migration is declared from ${protocol}@${u.version} to ${ref} (needed for ${u.subject}). The protocol's author has to publish one` });
          continue;
        }
        row.state = 'pending';
        row.path = route.map((e) => `${e.from}→${e.to}`);
        for (const e of route) hops.set(e.id, e);
        if (u.kind === 'library') (newSelection.libraries[u.subject] ??= {})[protocol] = t.version;
        else newSelection.use[protocol] = t.version;
      }

      // Migrations already recorded in the ledger are consulted too, but only for what is still
      // left to do by hand; their automatic changes are never applied a second time
      for (const e of registry.migrationEdges(protocol)) {
        if (appliedIds.has(e.id) && compareProtocolVersions(e.to, t.version) <= 0) hops.set(e.id, e);
      }

      // The migration code, hop by hop; each hop sees the files as the previous hops left them
      for (const edge of [...hops.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || (a.from < b.from ? -1 : 1))) {
        const already = appliedIds.has(edge.id);
        const found = await findMigration(edge, { registry, packages: scan.packages, root, config });
        const step = { id: edge.id, protocol, from: edge.from, to: edge.to, strategy: edge.strategy, origin: found.origin, state: already ? 'applied' : 'pending', code: found.status };
        result.steps.push(step);

        if (found.status !== 'ok') {
          step.state = 'blocked';
          step.reason = found.message;
          if (edge.strategy === 'manual' && found.status === 'missing') {
            result.manual.push({ migration: edge.id, message: `${protocol}@${edge.from} → ${edge.to} has to be done by hand.`, hint: found.message });
            step.state = already ? 'applied' : 'manual';
          } else if (!already) {
            result.blockers.push({ message: `${edge.id}: ${found.message}` });
          }
          continue;
        }

        let plan;
        try {
          plan = (await found.migration.plan(view())) ?? {};
        } catch (err) {
          step.state = 'blocked';
          result.blockers.push({ message: `${edge.id}: plan() failed: ${err.message}` });
          continue;
        }
        for (const m of plan.manual ?? []) result.manual.push({ migration: edge.id, file: m.file, message: m.message, hint: m.hint });

        if (already) {
          // recorded as applied: its changes are never applied again, but leftovers are still reported
          if ((plan.operations ?? []).length) result.notes.push(`${edge.id} is recorded as applied, but its plan still wants to change ${plan.operations.map((o) => o.file).join(', ')}. Those changes were ignored.`);
          continue;
        }
        for (const op of plan.operations ?? []) {
          try {
            await stage(op, edge.id);
          } catch (err) {
            step.state = 'blocked';
            result.blockers.push({ message: `${edge.id}: ${err.message}` });
          }
        }
      }
    }

    // The core part of every migration: which generation each library and the application use
    if (serializeSelection(newSelection) !== serializeSelection(selection)) {
      try {
        await stage({ kind: (await createProjectView({ root, config, overlay: new Map() }).exists(SELECTION_FILE)) ? 'edit' : 'create', file: SELECTION_FILE, content: serializeSelection(newSelection), reason: 'record the protocol generations in use' }, 'white');
      } catch (err) {
        result.blockers.push({ message: err.message });
      }
    }

    async function stage(op, migrationId) {
      if (!op || !['edit', 'create'].includes(op.kind)) throw new MigrationError(`unsupported operation ${JSON.stringify(op?.kind)}. Migrations may only edit or create files, never delete them`);
      const file = safePath(root, op.file, { forWrite: true });
      if (typeof op.content !== 'string') throw new MigrationError(`${file}: the new content must be a string`);
      if (Buffer.byteLength(op.content) > MAX_FILE) throw new MigrationError(`${file}: the new content is larger than 2 MB`);
      if (!original.has(file)) {
        original.set(file, await fs.readFile(path.join(root, file), 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e))));
      }
      const exists = overlay.has(file) ? overlay.get(file) !== null : original.get(file) !== null;
      if (op.kind === 'edit' && !exists) throw new MigrationError(`${file}: cannot edit a file that does not exist`);
      if (op.kind === 'create' && exists) throw new MigrationError(`${file}: cannot create a file that already exists`);
      overlay.set(file, op.content);
      (reasons.get(file) ?? reasons.set(file, []).get(file)).push({ migration: migrationId, reason: op.reason });
    }

    // Files, in the order of the first change
    for (const [file, after] of overlay) {
      const before = original.get(file);
      if (before === after) continue; // changes cancelled out
      const lines = before === null ? 0 : nonBlank(before);
      const destructive = before !== null && lines >= 20 && nonBlank(after) < lines * 0.5;
      result.files.push({
        file,
        kind: before === null ? 'create' : 'edit',
        beforeHash: before === null ? null : sha256(before),
        afterHash: sha256(after),
        after,
        diff: unifiedDiff(file, before, after),
        stats: diffStats(before, after),
        reasons: reasons.get(file),
        destructive,
      });
    }
    result.automatic = result.files.length;
    result.pending = result.steps.filter((s) => s.state === 'pending').length;
    result.upToDate = !result.blockers.length && !result.files.length && !result.manual.length && !result.users.some((u) => u.state === 'pending');
    result.canApply = !result.blockers.length && result.files.length > 0;
    result.hash = sha256(JSON.stringify([result.targets, result.steps.map((s) => s.id), result.files.map((f) => [f.file, f.beforeHash, f.afterHash])]));
    return result;
  }

  // ── Automatic migration ────────────────────────────────────────────────

  async function apply(plan, { allowDestructive = false, onStage = () => {} } = {}) {
    if (!plan.canApply) throw new MigrationError(plan.blockers[0]?.message ?? 'This plan has nothing to apply');
    const risky = plan.files.filter((f) => f.destructive);
    if (risky.length && !allowDestructive) {
      throw new MigrationError(`The migration would remove most of ${risky.map((f) => f.file).join(', ')}. Review the diff, then confirm with --allow-destructive`, { code: 'MIGRATION_DESTRUCTIVE' });
    }

    const release = await acquireLock(root);
    const runId = newRunId();
    let journal;
    try {
      const interrupted = await incompleteRuns(root);
      if (interrupted.length) throw new MigrationError(`An earlier migration run was interrupted (${interrupted.map((r) => r.runId).join(', ')}). Run: white migrate --recover`, { code: 'MIGRATION_INTERRUPTED' });

      // The project must be exactly as it was when the plan was made
      onStage('checking');
      const fresh = await plan_(plan);
      if (fresh) throw new MigrationError(fresh, { code: 'MIGRATION_STALE' });

      const ledger = await readLedger(root);
      const done = plan.steps.filter((s) => s.state === 'pending' && ledger.applied.some((a) => a.id === s.id));
      if (done.length) throw new MigrationError(`Already applied: ${done.map((s) => s.id).join(', ')}`, { code: 'MIGRATION_ALREADY_APPLIED' });

      // Journal first, then backups, then the first write
      onStage('backing up');
      journal = { runId, state: 'applying', startedAt: now().toISOString(), plan: plan.hash, targets: plan.targets, files: plan.files.map((f) => ({ file: f.file, kind: f.kind, beforeHash: f.beforeHash, afterHash: f.afterHash })) };
      await writeJournal(root, runId, journal);
      for (const f of plan.files) if (f.kind === 'edit') await backupFile(root, runId, f.file);

      onStage('writing');
      for (const f of plan.files) {
        const abs = path.join(root, f.file);
        if (f.kind === 'create') {
          if (await fs.access(abs).then(() => true, () => false)) throw new MigrationError(`${f.file} appeared while the migration was running`);
        }
        await writeAtomic(abs, f.after);
      }

      onStage('verifying');
      for (const f of plan.files) {
        if (sha256(await fs.readFile(path.join(root, f.file), 'utf8')) !== f.afterHash) throw new MigrationError(`${f.file} does not contain what was written`);
      }
      const problems = await verify(plan);
      if (problems.length) throw new MigrationError(`Verification failed:\n  - ${problems.join('\n  - ')}`, { code: 'MIGRATION_VERIFY_FAILED' });

      await appendLedger(
        root,
        plan.steps
          .filter((s) => s.state === 'pending')
          .map((s) => ({ id: s.id, protocol: s.protocol, from: s.from, to: s.to, appliedAt: now().toISOString(), runId, origin: s.origin, framework: frameworkVersion, files: plan.files.map((f) => ({ file: f.file, before: f.beforeHash, after: f.afterHash })), manualPending: plan.manual.filter((m) => m.migration === s.id).length })),
      );
      journal.state = 'done';
      journal.finishedAt = now().toISOString();
      await writeJournal(root, runId, journal);
      return { runId, files: plan.files.map((f) => f.file), manual: plan.manual, steps: plan.steps.filter((s) => s.state === 'pending').map((s) => s.id) };
    } catch (err) {
      if (!journal) throw err; // nothing was touched yet
      onStage('rolling back');
      const problems = await restoreRun(root, runId, journal);
      journal.state = problems.length ? 'rollback-failed' : 'rolled-back';
      journal.error = err.message;
      if (problems.length) journal.rollbackProblems = problems;
      await writeJournal(root, runId, journal).catch(() => {});
      const failure = new MigrationError(
        problems.length
          ? `${err.message}\nThe rollback was incomplete (${problems.join('; ')}). Originals are in ${path.relative(root, runDir(root, runId))}/backup. Run: white migrate --recover`
          : `${err.message}\nNo changes were kept: the project is as it was before.`,
        { code: err.code ?? 'MIGRATION_FAILED', cause: err },
      );
      failure.rolledBack = problems.length === 0;
      failure.runId = runId;
      throw failure;
    } finally {
      await release();
    }
  }

  // Do the files still match what the plan was made from? Returns a message, or null.
  async function plan_(plan) {
    for (const f of plan.files) {
      const abs = path.join(root, f.file);
      const current = await fs.readFile(abs, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (f.kind === 'edit' && (current === null || sha256(current) !== f.beforeHash)) return `${f.file} changed after the plan was made. Run the migration again`;
      if (f.kind === 'create' && current !== null) return `${f.file} now exists. Run the migration again`;
    }
    return null;
  }

  // Runs each migration's verify() on the migrated project, and checks the protocol state again
  async function verify(plan) {
    const problems = [];
    const { registry, scan } = reload();
    const view = createProjectView({ root, config, protocols: Object.freeze({ selection: state.selection, users: state.report.users.map((u) => ({ ...u })) }) });
    for (const step of plan.steps.filter((s) => s.state === 'pending')) {
      const edge = registry.migrationEdges(step.protocol).find((e) => e.id === step.id);
      const found = edge && (await findMigration(edge, { registry, packages: scan.packages, root, config }));
      if (found?.status === 'ok' && found.migration.verify) {
        try {
          const r = await found.migration.verify(view);
          if (r && r.ok === false) problems.push(...(r.problems?.length ? r.problems : [`${step.id} reported a problem`]).map((p) => `${step.id}: ${p}`));
        } catch (err) {
          problems.push(`${step.id}: verify() threw: ${err.message}`);
        }
      }
    }
    for (const u of plan.users.filter((x) => x.state === 'pending')) {
      const now_ = state.report.users.find((x) => x.subject === u.subject && x.protocol === u.protocol);
      if (!now_ || now_.version !== u.to) problems.push(`${u.subject} still uses ${u.protocol}@${now_?.version ?? '?'} instead of ${u.to}`);
    }
    return problems;
  }

  // ── Recovery ───────────────────────────────────────────────────────────

  // Restores the project after a run that did not finish. Safe to run repeatedly.
  async function recover() {
    const runs = await incompleteRuns(root);
    if (!runs.length) return { recovered: [] };
    const release = await acquireLock(root);
    try {
      const recovered = [];
      for (const { runId, journal } of runs) {
        const problems = await restoreRun(root, runId, journal);
        if (problems.length) throw new MigrationError(`Could not restore ${runId}:\n  - ${problems.join('\n  - ')}`);
        journal.state = 'rolled-back';
        journal.recoveredAt = now().toISOString();
        await writeJournal(root, runId, journal);
        recovered.push({ runId, files: journal.files.map((f) => f.file) });
      }
      return { recovered };
    } finally {
      await release();
    }
  }

  // ── Manual migration ───────────────────────────────────────────────────

  // Markdown instructions for doing a migration by hand: what to change, where and why
  function manualGuide(plan) {
    const out = [`# Migration guide: ${plan.targets.join(', ') || 'mandatory migrations'}`, ''];
    if (plan.blockers.length) {
      out.push('## Before you start', '', ...plan.blockers.map((b) => `- ${b.message}`), '');
    }
    if (plan.users.length) {
      out.push('## What uses the protocol', '', ...plan.users.map((u) => `- ${u.subject} (${u.kind}): ${u.protocol}@${u.from} → ${u.to} [${u.state}]`), '');
    }
    let n = 1;
    if (plan.files.length) {
      out.push('## Changes to make', '');
      for (const f of plan.files) {
        out.push(`### ${n++}. ${f.kind === 'create' ? 'Create' : 'Edit'} \`${f.file}\``, '');
        for (const r of f.reasons ?? []) if (r.reason) out.push(`${r.reason} (${r.migration}).`, '');
        out.push('```diff', f.diff, '```', '');
      }
    }
    if (plan.manual.length) {
      out.push('## Steps that cannot be automated', '');
      for (const m of plan.manual) out.push(`### ${n++}. ${m.message}`, '', ...(m.file ? [`File: \`${m.file}\``, ''] : []), ...(m.hint ? [m.hint, ''] : []), `From migration \`${m.migration}\`.`, '');
    }
    out.push('## Afterwards', '', '1. Run `white doctor` and check the protocol section.', '2. Run your tests.', '3. If you edited files by hand, `white.protocols.json` is what records the generation in use; the diff above shows its new content.', '');
    return out.join('\n');
  }

  return { plan, apply, recover, manualGuide, get state() { return state; } };
}
