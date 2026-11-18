# Migrations

`white migrate` moves a project from one generation of a protocol to another. It is a separate step: it does not update npm packages, and updating npm packages does not run it.

```bash
white migrate meta@3.0 --analyze    # 1. Analysis: what would change? Writes nothing.
white migrate meta@3.0              # 2. Automatic: asks, backs up, applies, verifies, or restores.
white migrate meta@3.0 --manual     # 3. Manual: a step-by-step guide to do it yourself.
white migrate                       # the migrations forced by blocked or removed versions
white migrate --recover             # restore the project after an interrupted run
```

| Option | Effect |
| --- | --- |
| `--analyze` (`--dry-run`) | plan with diffs; no file, lock or `.white/` folder is created |
| `--manual [--out file]` | print (or write) Markdown instructions; never touches the project |
| `--yes`, `-y` | do not ask. Without a terminal, `--yes` is required, otherwise nothing is changed |
| `--diff` | show the diffs before asking |
| `--allow-destructive` | confirm a migration that removes most of a file |
| `--recover` | restore an interrupted run |
| `--json` | the plan as JSON |

Exit codes: `0` done, nothing to do, or analysis/guide produced; `1` cannot migrate, failed (and rolled back), or bad usage; `130` cancelled.

## What `white migrate meta@3.0` does

1. Reads which generation of `meta` every library and the application use.
2. Checks the target: registered, not blocked or removed, compatible with this White.js, implemented by an installed package.
3. Finds the **declared** migration path from each current generation to the target (several hops are fine: `2.0 → 3.0 → 4.0`). No declared path means no migration; it says so and why.
4. Checks that each library to be switched supports the target. If not, it reports which library to update (an npm matter).
5. Loads the migration code (after the integrity and provenance checks below) and asks it for a plan.
6. Shows the plan: who uses what, which migrations, which files change (with diffs), what needs a human, what blocks.
7. Asks for confirmation. Then backs up, writes, verifies, records, or restores.
8. Prints a report.

The plan always includes one change made by White.js itself: `white.protocols.json` records the generation each library (and the application) uses. That file is how a generation is *selected*; nothing is switched implicitly.

## The three modes

**Analysis** reads and describes. It creates no files, takes no lock, writes no journal. (It does import verified migration modules to ask them for a plan; see [integrity and provenance](#integrity-and-provenance).)

**Automatic** applies only what migrations returned as operations, after you confirm.

**Manual** is for changes that cannot be automated safely, or when you prefer to do them yourself. `--manual` prints, for every file, what to change and why with the diff, then the steps a migration flagged as manual. A migration can mix both: the automatic part is applied, the rest is listed under "Needs you" and stays listed every time you run `white migrate` until it is gone.

## Safety guarantees

- **Plan first.** Nothing is written without a plan that you have seen. The plan is checked against the files again right before writing: if a file changed in between (hash mismatch), nothing is applied.
- **Operations are limited.** A migration can *edit* an existing file or *create* a new one. There is no delete. It cannot touch `package.json` or lockfiles (a migration is not a dependency update), `node_modules`, `.git`, `.white`, or anything outside the project.
- **No silent destruction.** An edit that removes more than half of a file's lines (files of 20+ lines) is flagged and refused unless you pass `--allow-destructive`.
- **Backup, journal, lock.** Before the first write, a journal (`.white/migrations/<run>/journal.json`, state `applying`) and a copy of every file to be edited are written. Files are replaced atomically (temp file, rename). One migration runs at a time per project; a lock left by a dead process is taken over.
- **Verification.** After writing, every file is re-read and compared with the plan; each migration's `verify()` runs; and the protocol state is recomputed to confirm that every library and the application now use the target.
- **Rollback.** Any failure restores the edited files from the backup and removes created ones. The report says whether the rollback was complete. If the process dies mid-run, the next `white migrate` refuses to start and tells you to run `white migrate --recover`, which restores from the journal. Recovering twice is harmless.
- **Not twice.** Applied migrations are recorded in `white.migrations.json` (commit it). A recorded migration's operations are never applied again; its `plan()` is still asked for leftovers that need a human. Migrations must also be idempotent: on a project that is already migrated, `plan()` returns no operations.
- **Failed runs are not recorded** as applied.

State on disk:

| Path | What | Commit? |
| --- | --- | --- |
| `white.protocols.json` | generation in use per library and for the app | yes |
| `white.migrations.json` | ledger: id, versions, time, files with before/after hashes, run id | yes |
| `.white/migrations/<run>/` | journal and backups of one run | no (add `.white/` to `.gitignore`) |
| `.white/migrate.lock` | exists while a migration runs | no |

## Integrity and provenance

A migration module is code, and `white migrate` imports it. So before that:

- **Provenance.** A module shipped in a package is used only for protocol versions that the **same package defines**, and the file must lie inside the package. A package cannot migrate someone else's protocol.
- **Integrity.** The protocol manifest declares `migration.integrity`, `sha256-<base64>` of the migration file. If the file does not match (it was changed, or tampered with), or the manifest declares no integrity, the migration is **unverified** and never imported or run; the plan reports it as a blocker.
- The module must export a migration with the declared `id`, `protocol`, `from` and `to`; one that claims otherwise is rejected.

Get the value for the manifest with `white protocol integrity ./migrations.js`, and update it whenever the file changes.

Migrations written in the project itself (`dirs.migrations`, default `server/migrations/`) are your own code and need neither check.

Be clear about the limit: these checks decide whether to trust a module, they do not sandbox it. A trusted module could still write files with `node:fs`. The project view it is given has no write methods, and the engine checks every operation it returns, but treat a migration like any dependency you run.

## Writing a migration

See [library-authors.md](library-authors.md#writing-a-migration). The short version:

```js
import { defineMigration } from 'white-js';

export default defineMigration({
  id: 'meta-2.0-to-3.0',
  protocol: 'meta', from: '2.0', to: '3.0',
  async plan(project) {
    const operations = [];
    const manual = [];
    for (const file of await project.list('server', { ext: '.js' })) {
      const text = await project.read(file);
      if (text.includes('meta.tags')) operations.push(project.edit(file, text.replaceAll('meta.tags', 'meta.labels'), 'renamed'));
      if (text.includes('meta.legacyHook')) manual.push({ file, message: 'meta.legacyHook was removed', hint: 'Use meta.on("change").' });
    }
    return { operations, manual };
  },
  async verify(project) { /* optional: return { ok, problems } */ },
});
```

## Limits

- Migrations change the **project**. They do not install or update packages; when a library does not support the target, `white migrate` says which one to update and stops.
- The same migration path can be applied to several projects, but the ledger is per project. In a multi-service system each service is migrated on its own, and `ctx.protocols.fingerprint` (shown in `/_white/manifest`) lets you see which services disagree.
- `white.config.js` is not edited by the core step. A migration that must change it should return a `manual` item or an `edit` of its own.
