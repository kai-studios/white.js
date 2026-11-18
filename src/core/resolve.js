import fs from 'node:fs';
import path from 'node:path';
import { PluginResolutionError } from './white-error.js';

// How White.js finds a plugin. One algorithm, always anchored at the project root (never at
// the location of White.js itself), and it never executes anything, so `white doctor` can use it.
//
//   './local.js', '../x', '/abs/x.js'   a file (extension optional) or a folder with package.json / index.js
//   'name', '@scope/name', 'name/sub'   a package found in <root>/node_modules or a parent's node_modules
//
// Packages with an "exports" map are resolved by it, with the conditions of the module system
// that loads them: `import` (the normal way, ESM and CommonJS packages alike) and, as a
// fallback for packages that only offer a CommonJS entry, `require`.
const CONDITIONS = {
  import: ['node', 'import', 'module-sync', 'default'],
  require: ['node', 'require', 'module-sync', 'default'],
};
const EXTENSIONS = ['.js', '.mjs', '.cjs'];

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function withExtension(base) {
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS) if (isFile(base + ext)) return base + ext;
  return null;
}

function fromDirectory(dir, pkg) {
  const main = pkg?.main && withExtension(path.resolve(dir, pkg.main));
  if (main) return main;
  if (pkg?.main && isDir(path.resolve(dir, pkg.main))) return fromDirectory(path.resolve(dir, pkg.main), readJson(path.join(dir, pkg.main, 'package.json')));
  for (const ext of EXTENSIONS) if (isFile(path.join(dir, 'index' + ext))) return path.join(dir, 'index' + ext);
  return null;
}

// ── "exports" ──────────────────────────────────────────────────────────

function target(value, conditions, star) {
  if (value === null) return null; // explicitly blocked
  if (typeof value === 'string') return value.startsWith('./') ? (star === undefined ? value : value.replaceAll('*', star)) : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = target(item, conditions, star);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'default' && !conditions.includes(key)) continue;
      const found = target(inner, conditions, star);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function resolveExports(exportsField, subpath, conditions) {
  const sugar =
    typeof exportsField === 'string' ||
    Array.isArray(exportsField) ||
    (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((k) => k.startsWith('.')));
  const map = sugar ? { '.': exportsField } : exportsField;

  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return target(map[subpath], conditions);

  let best = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length && (!best || prefix.length > best.prefix.length)) {
      best = { key, prefix, suffix };
    }
  }
  if (!best) return undefined;
  return target(map[best.key], conditions, subpath.slice(best.prefix.length, subpath.length - best.suffix.length));
}

// ── Public API ─────────────────────────────────────────────────────────

function parseBare(spec) {
  const parts = spec.split('/');
  const nameLength = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const rest = parts.slice(nameLength).join('/');
  return { name, subpath: rest ? `./${rest}` : '.' };
}

function lookup(name, root) {
  const searched = [];
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    searched.push(path.join(dir, 'node_modules'));
    if (isDir(candidate)) return { dir: candidate, searched };
    if (path.dirname(dir) === dir) return { dir: null, searched };
  }
}

// Finds an installed package by name, searching node_modules folders from `root` upwards.
// Returns { dir, packageJson } or null. Reads package.json only; nothing is executed.
export function findPackage(name, root) {
  const { dir } = lookup(name, root);
  if (!dir) return null;
  const packageJson = readJson(path.join(dir, 'package.json'));
  return packageJson ? { dir, packageJson } : null;
}

// Returns { file, kind: 'path' | 'package', mode: 'import' | 'require', name?, dir?, packageJson? }
// or throws PluginResolutionError (code PLUGIN_NOT_FOUND | PLUGIN_ENTRY_NOT_EXPORTED).
export function resolveModule(spec, root, { mode = 'import' } = {}) {
  if (typeof spec !== 'string' || !spec) throw new PluginResolutionError('A plugin must be a function or a non-empty module name or path');

  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const base = path.resolve(root, spec);
    const file = withExtension(base) ?? (isDir(base) ? fromDirectory(base, readJson(path.join(base, 'package.json'))) : null);
    if (!file) {
      throw new PluginResolutionError(`Plugin "${spec}" was not found (looked for ${path.relative(root, base) || base}${EXTENSIONS.join('|')} and an index file)`, {
        code: 'PLUGIN_NOT_FOUND',
        hint: 'Check the path, which is relative to the project root.',
      });
    }
    return { file, kind: 'path', mode };
  }

  const { name, subpath } = parseBare(spec);
  const found = lookup(name, root);
  if (!found.dir) {
    throw new PluginResolutionError(`Plugin "${spec}" is not installed (searched ${found.searched.length} node_modules folder${found.searched.length === 1 ? '' : 's'} from ${root})`, {
      code: 'PLUGIN_NOT_FOUND',
      hint: `Run: npm install ${name}`,
      details: { searched: found.searched },
    });
  }

  const packageJson = readJson(path.join(found.dir, 'package.json')) ?? {};
  const make = (file, m) => ({ file, kind: 'package', mode: m, name, dir: found.dir, packageJson });

  if (packageJson.exports !== undefined && packageJson.exports !== null) {
    for (const m of mode === 'import' ? ['import', 'require'] : ['require']) {
      const relative = resolveExports(packageJson.exports, subpath, CONDITIONS[m]);
      if (relative === undefined || relative === null) continue;
      const file = path.resolve(found.dir, relative);
      if (isFile(file)) return make(file, m);
    }
    throw new PluginResolutionError(`"${spec}" does not export ${subpath === '.' ? 'a main entry' : `"${subpath}"`} for ${mode === 'import' ? 'import or require' : 'require'}`, {
      code: 'PLUGIN_ENTRY_NOT_EXPORTED',
      hint: `Check the "exports" field in ${path.join(found.dir, 'package.json')}.`,
    });
  }

  const file = subpath === '.' ? fromDirectory(found.dir, packageJson) : withExtension(path.join(found.dir, subpath));
  if (!file) {
    throw new PluginResolutionError(`"${spec}" is installed but has no entry file (no "exports", "main" or index.js)`, { code: 'PLUGIN_NOT_FOUND' });
  }
  return make(file, 'import');
}

// The function a plugin module exports: `export default fn`, or `module.exports = fn`, or
// `exports.default = fn` from CommonJS compiled by a transpiler
export function pickPluginFunction(mod) {
  if (typeof mod?.default === 'function') return mod.default;
  if (typeof mod?.default?.default === 'function') return mod.default.default;
  return undefined;
}
