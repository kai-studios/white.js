import fs from 'node:fs/promises';
import path from 'node:path';
import { MigrationError } from '../core/white-error.js';

// The read-only view of a project that a migration works with, and the constructors for the
// operations it may return. Paths are always relative to the project root, with "/" separators.

const SKIP_DIRS = new Set(['node_modules', '.git', '.white']);
const FORBIDDEN = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
export const MAX_FILE = 2 * 1024 * 1024;

// Returns the normalised relative path, or throws if it would leave the project or touch a forbidden place
export function safePath(root, file, { forWrite = false } = {}) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\0')) throw new MigrationError(`Invalid project path ${JSON.stringify(file)}: it must be relative to the project root`);
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new MigrationError(`"${file}" is outside the project`);
  const top = rel.split('/')[0];
  if (SKIP_DIRS.has(top)) throw new MigrationError(`"${rel}": migrations may not touch ${top}/`);
  if (forWrite && FORBIDDEN.has(rel)) throw new MigrationError(`"${rel}": migrations do not change dependencies. Use npm for package.json and lockfiles`);
  return rel;
}

export function createProjectView({ root, config, protocols, overlay = new Map() }) {
  const view = {
    root,
    config,
    protocols,

    async read(file) {
      const rel = safePath(root, file);
      if (overlay.has(rel)) {
        const o = overlay.get(rel);
        if (o === null) throw new MigrationError(`${rel} does not exist`);
        return o;
      }
      const stat = await fs.stat(path.join(root, rel));
      if (stat.size > MAX_FILE) throw new MigrationError(`${rel} is larger than ${MAX_FILE / 1024 / 1024} MB`);
      return fs.readFile(path.join(root, rel), 'utf8');
    },

    async readJson(file) {
      return JSON.parse(await view.read(file));
    },

    async exists(file) {
      const rel = safePath(root, file);
      if (overlay.has(rel)) return overlay.get(rel) !== null;
      try {
        await fs.access(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    },

    // Files below a folder (recursive), sorted, without node_modules, .git and .white
    async list(dir = '.', { ext } = {}) {
      const start = dir === '.' ? '' : safePath(root, dir);
      const out = [];
      const walk = async (rel) => {
        let entries;
        try {
          entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
          throw err;
        }
        for (const e of entries) {
          if (SKIP_DIRS.has(e.name) && !rel) continue;
          const child = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(child);
          else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(child);
        }
      };
      await walk(start);
      for (const rel of overlay.keys()) if ((!start || rel.startsWith(start + '/')) && (!ext || rel.endsWith(ext)) && !out.includes(rel) && overlay.get(rel) !== null) out.push(rel);
      return out.sort();
    },

    // ── operation constructors (they only describe a change; nothing is written here) ──
    edit(file, content, reason = '') {
      return { kind: 'edit', file: safePath(root, file, { forWrite: true }), content: String(content), reason };
    },
    create(file, content, reason = '') {
      return { kind: 'create', file: safePath(root, file, { forWrite: true }), content: String(content), reason };
    },
    async editJson(file, change, reason = '') {
      const data = await view.readJson(file);
      const next = (await change(structuredClone(data))) ?? data;
      return view.edit(file, JSON.stringify(next, null, 2) + '\n', reason);
    },
  };
  return Object.freeze(view);
}
