import { isProtocolName, isProtocolVersion, isRange, tryParseRef, parseRef } from './version.js';

// Declarative descriptions. Nothing here is executed: manifests are plain JSON-compatible data,
// read from package.json files or from white.config.js.
//
// Protocol manifest (one per version of a protocol):
//   {
//     name: 'meta', version: '3.0',
//     status: 'current',                       // current | supported | deprecated | blocked | removed
//     compatibility: {
//       white: '>=0.4.0',                      // frameworks this version works with (semver range)
//       protocols: ['meta@2.0'],               // generations it interoperates with. Explicit; never inferred
//     },
//     replaces: 'meta@2.0',
//     migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0' },
//     coexistence: 'multiple',                 // 'single': only one generation may be active in a process
//     implementation: 'builtin',               // shipped with White.js; otherwise a package lists it in `provides`
//     advisory: { id: 'WHITE-2026-001', severity: 'critical', summary: '...', url: '...' },
//     deprecation: { since: '2026-06', removeIn: '4.0', message: '...' },
//   }
//
// Library manifest: the "white" field of its package.json
//   {
//     framework: '>=0.4.0',
//     protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } },
//     provides:  { meta: ['2.0', '3.0'] },     // implementations this package ships
//     defines:   [ ...protocol manifests ],    // protocol versions this package introduces
//     migrations: './migrations/index.js',     // module with the migrations for protocols it defines
//   }

export const STATUSES = Object.freeze(['current', 'supported', 'deprecated', 'blocked', 'removed']);
export const STRATEGIES = Object.freeze(['automatic', 'manual']);
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const freezeDeep = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
};

// Returns { manifest, problems }. `manifest` is a frozen, normalised copy (or null with problems).
export function validateProtocolManifest(input) {
  const problems = [];
  const at = (msg) => problems.push(msg);
  if (!isObject(input)) return { manifest: null, problems: ['a protocol manifest must be an object'] };

  if (!isProtocolName(input.name)) at(`name ${JSON.stringify(input.name)} must be lowercase letters, digits and "-", starting with a letter`);
  if (!isProtocolVersion(input.version)) at(`version ${JSON.stringify(input.version)} must be MAJOR.MINOR, for example "3.0"`);
  if (!STATUSES.includes(input.status)) at(`status must be one of: ${STATUSES.join(', ')}`);

  const compatibility = input.compatibility ?? {};
  if (!isObject(compatibility)) at('compatibility must be an object');
  else {
    if (compatibility.white !== undefined && !isRange(compatibility.white)) at(`compatibility.white ${JSON.stringify(compatibility.white)} is not a valid semver range`);
    for (const ref of compatibility.protocols ?? []) {
      const parsed = tryParseRef(ref);
      if (!parsed) at(`compatibility.protocols: ${JSON.stringify(ref)} is not name@MAJOR.MINOR`);
      else if (parsed.name !== input.name) at(`compatibility.protocols: ${ref} belongs to another protocol (interoperability is declared within one protocol)`);
      else if (parsed.version === input.version) at('compatibility.protocols must not list the version itself');
    }
  }

  for (const key of ['replaces']) {
    if (input[key] === undefined) continue;
    const parsed = tryParseRef(input[key]);
    if (!parsed || parsed.name !== input.name) at(`${key} must be a reference to another version of ${input.name}, such as ${input.name}@2.0`);
  }

  if (input.migration !== undefined) {
    const m = input.migration;
    const from = tryParseRef(m?.from);
    const to = tryParseRef(m?.to);
    if (!isObject(m)) at('migration must be an object');
    else {
      if (!from || from.name !== input.name) at(`migration.from must be a reference to a version of ${input.name}`);
      if (!to || to.name !== input.name) at(`migration.to must be a reference to a version of ${input.name}`);
      if (to && to.id !== `${input.name}@${input.version}`) at(`migration.to must be ${input.name}@${input.version} (a migration is declared by the version it leads to)`);
      if (from && to && from.id === to.id) at('migration.from and migration.to must differ');
      if (!STRATEGIES.includes(m.strategy)) at(`migration.strategy must be one of: ${STRATEGIES.join(', ')}`);
      if (m.id !== undefined && !/^[a-z0-9][a-z0-9._/@-]{2,120}$/i.test(m.id)) at('migration.id may only contain letters, digits and . _ / @ -');
      if (m.integrity !== undefined && !/^sha256-[A-Za-z0-9+/]{43}=$/.test(m.integrity)) at('migration.integrity must look like "sha256-<base64>"');
    }
  }

  if (input.coexistence !== undefined && !['multiple', 'single'].includes(input.coexistence)) at('coexistence must be "multiple" or "single"');
  if (input.implementation !== undefined && input.implementation !== 'builtin') at('implementation can only be "builtin"; other implementations are declared by packages in "provides"');
  if (input.advisory !== undefined) {
    if (!isObject(input.advisory) || typeof input.advisory.id !== 'string' || typeof input.advisory.summary !== 'string') at('advisory needs "id" and "summary"');
    else if (input.advisory.severity !== undefined && !SEVERITIES.includes(input.advisory.severity)) at(`advisory.severity must be one of: ${SEVERITIES.join(', ')}`);
  }
  if (input.status === 'blocked' && input.advisory === undefined && typeof input.reason !== 'string') {
    at('a blocked version needs an "advisory" (security) or a "reason" (compatibility)');
  }

  if (problems.length) return { manifest: null, problems };
  const manifest = freezeDeep({
    name: input.name,
    version: input.version,
    status: input.status,
    compatibility: { ...(compatibility.white && { white: compatibility.white }), protocols: [...(compatibility.protocols ?? [])] },
    ...(input.replaces && { replaces: input.replaces }),
    ...(input.migration && { migration: { ...input.migration } }),
    coexistence: input.coexistence ?? 'multiple',
    ...(input.implementation && { implementation: input.implementation }),
    ...(input.advisory && { advisory: { ...input.advisory } }),
    ...(input.deprecation && { deprecation: { ...input.deprecation } }),
    ...(typeof input.reason === 'string' && { reason: input.reason }),
  });
  return { manifest, problems };
}

// Reads the "white" field of a package.json. Returns { library, problems }; `library` is null
// when the package does not take part in the protocol system.
export function readLibraryManifest(pkg) {
  const field = pkg?.white;
  if (field === undefined) return { library: null, problems: [] };
  const problems = [];
  const at = (msg) => problems.push(msg);
  if (!isObject(field)) return { library: null, problems: ['"white" must be an object'] };

  if (field.framework !== undefined && !isRange(field.framework)) at(`white.framework ${JSON.stringify(field.framework)} is not a valid semver range`);

  const protocols = {};
  for (const [name, spec] of Object.entries(field.protocols ?? {})) {
    if (!isProtocolName(name)) {
      at(`white.protocols: "${name}" is not a valid protocol name`);
      continue;
    }
    if (!isObject(spec) || !isProtocolVersion(spec.required)) {
      at(`white.protocols.${name}.required must be MAJOR.MINOR, for example "2.0"`);
      continue;
    }
    const supported = spec.supported ?? [spec.required];
    if (!Array.isArray(supported) || !supported.every(isProtocolVersion)) {
      at(`white.protocols.${name}.supported must be a list of MAJOR.MINOR versions`);
      continue;
    }
    if (!supported.includes(spec.required)) at(`white.protocols.${name}: "required" (${spec.required}) must also be listed in "supported"`);
    protocols[name] = { required: spec.required, supported: [...new Set(supported)], optional: spec.optional === true };
  }

  const provides = {};
  for (const [name, versions] of Object.entries(field.provides ?? {})) {
    if (!isProtocolName(name) || !Array.isArray(versions) || !versions.every(isProtocolVersion)) at(`white.provides.${name} must be a list of MAJOR.MINOR versions`);
    else provides[name] = [...new Set(versions)];
  }

  const defines = [];
  for (const [i, raw] of (field.defines ?? []).entries()) {
    const { manifest, problems: errs } = validateProtocolManifest(raw);
    if (manifest) defines.push(manifest);
    else errs.forEach((e) => at(`white.defines[${i}]: ${e}`));
  }

  if (field.migrations !== undefined && (typeof field.migrations !== 'string' || !field.migrations.startsWith('./') || field.migrations.includes('..'))) {
    at('white.migrations must be a path inside the package, such as "./migrations/index.js"');
  }

  const library = {
    name: pkg.name,
    version: pkg.version,
    framework: field.framework,
    protocols,
    provides,
    defines,
    migrations: field.migrations,
  };
  return { library: problems.length ? null : library, problems };
}

export { parseRef };
