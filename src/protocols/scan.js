import fs from 'node:fs';
import path from 'node:path';
import { findPackage } from '../core/resolve.js';
import { readLibraryManifest } from './manifest.js';
import { ProtocolRegistry } from './registry.js';
import { BUILTIN_PROTOCOLS } from './builtin.js';
import { isProtocolName, isProtocolVersion } from './version.js';

// Everything the compatibility check needs to know about a project is read from files:
// package.json of the project and of the libraries it depends on, and white.protocols.json.
// No library and no plugin is imported or run.

export const SELECTION_FILE = 'white.protocols.json';
const MAX_PACKAGES = 5000;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// white.protocols.json: the generation of each protocol that is actually in use.
//   { "version": 1,
//     "use": { "meta": "3.0" },                         // what the application's own code uses
//     "libraries": { "white-auth": { "meta": "3.0" } }  // overrides for a library; otherwise its "required"
//   }
// Changed by `white migrate`, reviewed and committed like a lockfile. Nothing switches generation implicitly.
export function readSelection(root) {
  const file = path.join(root, SELECTION_FILE);
  const empty = { version: 1, use: {}, libraries: {} };
  if (!fs.existsSync(file)) return { selection: empty, exists: false, problems: [] };
  const problems = [];
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    return { selection: empty, exists: true, problems: [`${SELECTION_FILE} is not valid JSON: ${err.message}`] };
  }
  const selection = { version: 1, use: {}, libraries: {} };
  if (raw.version !== 1) problems.push(`${SELECTION_FILE}: unsupported "version" ${JSON.stringify(raw.version)} (expected 1)`);
  for (const [name, v] of Object.entries(raw.use ?? {})) {
    if (isProtocolName(name) && isProtocolVersion(v)) selection.use[name] = v;
    else problems.push(`${SELECTION_FILE}: use.${name} must be a protocol name with a MAJOR.MINOR version`);
  }
  for (const [lib, map] of Object.entries(raw.libraries ?? {})) {
    selection.libraries[lib] = {};
    for (const [name, v] of Object.entries(map ?? {})) {
      if (isProtocolName(name) && isProtocolVersion(v)) selection.libraries[lib][name] = v;
      else problems.push(`${SELECTION_FILE}: libraries.${lib}.${name} must be a protocol name with a MAJOR.MINOR version`);
    }
  }
  return { selection, exists: true, problems };
}

// Finds the libraries that take part in the protocol system.
// Starts from the project's dependencies and the plugins in the config, and follows
// dependencies only through packages that have a "white" field themselves.
export function scanLibraries(root, { plugins = [] } = {}) {
  const result = { rootPackage: null, packages: [], invalid: [], missing: [] };
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      result.rootPackage = readJson(pkgFile);
    } catch (err) {
      result.invalid.push({ name: 'package.json', problems: [err.message] });
    }
  }
  const root_ = result.rootPackage ?? {};
  const queue = [
    ...Object.keys({ ...root_.dependencies, ...root_.optionalDependencies, ...root_.peerDependencies }),
    ...plugins.map((p) => (Array.isArray(p) ? p[0] : p)).filter((p) => typeof p === 'string' && !p.startsWith('.') && !path.isAbsolute(p)).map((p) => (p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0])),
  ];
  const seen = new Set();
  while (queue.length && seen.size < MAX_PACKAGES) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const found = findPackage(name, root);
    if (!found) {
      result.missing.push(name);
      continue;
    }
    const { library, problems } = readLibraryManifest(found.packageJson);
    if (problems.length) result.invalid.push({ name, problems });
    if (found.packageJson.white === undefined) continue;
    if (library) result.packages.push({ ...library, dir: found.dir });
    queue.push(...Object.keys({ ...found.packageJson.dependencies, ...found.packageJson.peerDependencies }));
  }
  result.packages.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

// Builds the registry from the three sources, in this order: White.js itself, installed
// libraries ("white.defines" and "white.provides"), the project (config.protocols.definitions
// and .block). Problems do not throw: they are returned, so the caller decides what they mean.
export function buildRegistry({ packages = [], config = {} } = {}) {
  const registry = new ProtocolRegistry();
  const problems = [];
  const attempt = (fn, what) => {
    try {
      fn();
    } catch (err) {
      problems.push({ code: 'registry-invalid', message: `${what}: ${err.message}` });
    }
  };

  for (const m of BUILTIN_PROTOCOLS) registry.register(m, { source: 'builtin' });

  for (const lib of packages) {
    for (const m of lib.defines) attempt(() => registry.register(m, { source: `${lib.name}@${lib.version}` }), `${lib.name}`);
    for (const [name, versions] of Object.entries(lib.provides)) {
      for (const v of versions) registry.addImplementation(name, v, { source: 'package', package: lib.name, packageVersion: lib.version });
    }
  }
  for (const [i, m] of (config.protocols?.definitions ?? []).entries()) attempt(() => registry.register(m, { source: 'white.config.js' }), `protocols.definitions[${i}]`);
  for (const ref of config.protocols?.block ?? []) {
    const [name, version] = String(ref).split('@');
    attempt(() => registry.setStatus(name, version, 'blocked', { reason: 'blocked in white.config.js (protocols.block)' }), `protocols.block "${ref}"`);
  }
  return { registry, problems };
}
