import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { integrityOf } from './diff.js';
import { defineMigration } from './kit.js';

// Finding the code of a migration, and deciding whether it may run.
//
// A migration module is code, so before it is even imported the engine checks:
//   provenance  a module shipped in a package is only used for protocol versions that the SAME
//               package defines (registry source = that package), and the file must lie inside it;
//   integrity   its sha256 must equal `migration.integrity` in the protocol manifest. A migration
//               without a declared integrity is "unverified" and is never executed.
// Migrations written in the project itself (dirs.migrations) are the project's own code and need
// neither. White.js ships none of its own yet; the table is where they would be registered.
export const BUILTIN_MIGRATIONS = new Map();

const listOf = (mod) => [].concat(mod.default ?? mod.migrations ?? []).filter(Boolean);

async function importMigrations(file) {
  const mod = await import(pathToFileURL(file).href);
  return listOf(mod).map((m) => defineMigration(m));
}

// Returns { status: 'ok' | 'missing' | 'unverified' | 'invalid', origin, migration?, message? }
export async function findMigration(edge, { registry, packages, root, config }) {
  if (BUILTIN_MIGRATIONS.has(edge.id)) return { status: 'ok', origin: 'builtin', migration: BUILTIN_MIGRATIONS.get(edge.id) };

  const lib = packages.find((p) => edge.source === `${p.name}@${p.version}`);
  if (lib?.migrations) {
    const file = path.resolve(lib.dir, lib.migrations);
    const inside = path.relative(await fs.realpath(lib.dir), await fs.realpath(file).catch(() => file));
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return { status: 'unverified', origin: lib.name, message: `${lib.name}: the migrations file is outside the package` };
    }
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch {
      return { status: 'missing', origin: lib.name, message: `${lib.name} declares migrations at ${lib.migrations}, but the file does not exist` };
    }
    if (!edge.integrity) {
      return { status: 'unverified', origin: lib.name, message: `${edge.id} has no "migration.integrity" in its manifest, so ${lib.name}'s migration code is not trusted` };
    }
    if (integrityOf(bytes) !== edge.integrity) {
      return { status: 'unverified', origin: lib.name, message: `${edge.id}: the migration file of ${lib.name} does not match the integrity declared in the manifest (${edge.integrity}). It was changed or tampered with` };
    }
    try {
      const found = (await importMigrations(file)).find((m) => m.id === edge.id);
      if (!found) return { status: 'invalid', origin: lib.name, message: `${lib.name} does not export a migration with id "${edge.id}"` };
      if (found.protocol !== edge.protocol || found.from !== edge.from || found.to !== edge.to) {
        return { status: 'invalid', origin: lib.name, message: `${edge.id} claims to migrate ${found.protocol}@${found.from} to ${found.to}, but the manifest declares ${edge.protocol}@${edge.from} to ${edge.to}` };
      }
      return { status: 'ok', origin: lib.name, migration: found };
    } catch (err) {
      return { status: 'invalid', origin: lib.name, message: `${edge.id}: ${err.message}` };
    }
  }

  // the project's own migrations
  const dir = path.resolve(root, config.dirs?.migrations ?? 'server/migrations');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.js')).sort();
  } catch {
    // no such folder
  }
  for (const f of files) {
    try {
      const found = (await importMigrations(path.join(dir, f))).find((m) => m.id === edge.id);
      if (found) return { status: 'ok', origin: 'project', migration: found };
    } catch (err) {
      return { status: 'invalid', origin: 'project', message: `${path.relative(root, path.join(dir, f))}: ${err.message}` };
    }
  }
  return { status: 'missing', origin: lib?.name ?? 'none', message: `No migration code was found for ${edge.id}` };
}
