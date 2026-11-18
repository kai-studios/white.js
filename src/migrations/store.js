import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { MigrationError } from '../core/white-error.js';

// Where migration state lives:
//   white.migrations.json              the ledger: which migrations were applied. Commit it, like a lockfile.
//   .white/migrate.lock                exists while a migration runs; one at a time per project
//   .white/migrations/<run>/journal.json   what a run is doing: written BEFORE the first file changes
//   .white/migrations/<run>/backup/…       the original of every file a run edits
// Add ".white/" to .gitignore.

export const LEDGER_FILE = 'white.migrations.json';
const STATE_DIR = '.white';

const exists = (p) => fs.access(p).then(() => true, () => false);

// Write to a temp file in the same folder, then rename: a reader never sees half a file
export async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, content);
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

// ── Ledger ──

export async function readLedger(root) {
  const file = path.join(root, LEDGER_FILE);
  if (!(await exists(file))) return { version: 1, applied: [] };
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new MigrationError(`${LEDGER_FILE} is not valid JSON (${err.message})`, { hint: 'Fix or restore it from version control; migrations are not applied while the ledger is unreadable.' });
  }
  if (data.version !== 1 || !Array.isArray(data.applied)) throw new MigrationError(`${LEDGER_FILE} has an unsupported format`);
  return data;
}

export async function appendLedger(root, entries) {
  const ledger = await readLedger(root);
  ledger.applied.push(...entries);
  await writeAtomic(path.join(root, LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n');
}

// ── Lock ──

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

export async function acquireLock(root) {
  const file = path.join(root, STATE_DIR, 'migrate.lock');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => fs.rm(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = {};
      try {
        holder = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        // unreadable lock: treated as stale below
      }
      if (holder.pid && alive(holder.pid)) {
        throw new MigrationError(`Another migration is running in this project (pid ${holder.pid}, started ${holder.startedAt})`, { code: 'MIGRATION_LOCKED' });
      }
      await fs.rm(file, { force: true }); // the process that held it is gone
    }
  }
  throw new MigrationError('Could not take the migration lock', { code: 'MIGRATION_LOCKED' });
}

// ── Journal and backups ──

export const runDir = (root, runId) => path.join(root, STATE_DIR, 'migrations', runId);
export const newRunId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

export async function writeJournal(root, runId, journal) {
  await writeAtomic(path.join(runDir(root, runId), 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
}

export async function backupFile(root, runId, rel) {
  const target = path.join(runDir(root, runId), 'backup', rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(root, rel), target);
}

// Puts back what a run changed: restores edited files from backup and removes files it created.
// Returns the list of problems (empty when everything was restored).
export async function restoreRun(root, runId, journal) {
  const problems = [];
  for (const f of journal.files) {
    const abs = path.join(root, f.file);
    try {
      if (f.kind === 'create') await fs.rm(abs, { force: true });
      else await fs.copyFile(path.join(runDir(root, runId), 'backup', f.file), abs);
    } catch (err) {
      problems.push(`${f.file}: ${err.message}`);
    }
  }
  return problems;
}

// Runs that started and neither finished nor were rolled back (the process died, or a rollback failed)
export async function incompleteRuns(root) {
  const base = path.join(root, STATE_DIR, 'migrations');
  let names;
  try {
    names = await fs.readdir(base);
  } catch {
    return [];
  }
  const runs = [];
  for (const runId of names.sort()) {
    try {
      const journal = JSON.parse(await fs.readFile(path.join(base, runId, 'journal.json'), 'utf8'));
      if (journal.state === 'applying' || journal.state === 'rollback-failed') runs.push({ runId, journal });
    } catch {
      // not a run directory
    }
  }
  return runs;
}
