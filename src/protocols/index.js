import { ProtocolError } from '../core/white-error.js';
import { version as frameworkVersion } from '../core/meta.js';
import { readLibraryManifest } from './manifest.js';
import { buildRegistry, readSelection, scanLibraries } from './scan.js';
import { createCompatibilityEngine, SEVERITY_ORDER } from './compat.js';

export { ProtocolRegistry } from './registry.js';
export { BUILTIN_PROTOCOLS } from './builtin.js';
export { createCompatibilityEngine, SEVERITY_ORDER } from './compat.js';
export { readSelection, scanLibraries, buildRegistry, SELECTION_FILE } from './scan.js';
export { validateProtocolManifest, readLibraryManifest, STATUSES } from './manifest.js';
export { parseRef, parseProtocolVersion, compareProtocolVersions, isProtocolVersion } from './version.js';

// Reads the project (files only, nothing is executed) and returns everything the compatibility
// check works with. Used by startup, `white doctor`, `white migrate` and `white protocol`.
export function loadProtocolState(config, root, { framework = frameworkVersion, now } = {}) {
  const scan = scanLibraries(root, { plugins: config.plugins });
  const { registry, problems: registryProblems } = buildRegistry({ packages: scan.packages, config });
  registry.freeze();
  const { selection, exists, problems: selectionProblems } = readSelection(root);
  const engine = createCompatibilityEngine({ registry, framework, selection, allow: config.protocols?.allow ?? [], now });
  const report = engine.analyze(scan.packages);

  // problems with the declarations themselves are findings too
  const declared = [
    ...registryProblems.map((p) => ({ severity: 'error', code: p.code, subject: 'registry', message: p.message })),
    ...selectionProblems.map((m) => ({ severity: 'error', code: 'selection-invalid', subject: 'white.protocols.json', message: m })),
    ...scan.invalid.map((i) => ({ severity: 'error', code: 'manifest-invalid', subject: i.name, message: `${i.name}: invalid "white" field:\n  - ${i.problems.join('\n  - ')}` })),
  ];
  if (declared.length) {
    report.findings.push(...declared);
    for (const f of declared) report.summary[f.severity] += 1;
    report.status = report.summary.critical ? 'CRITICAL' : report.summary.error ? 'ERROR' : report.summary.warning ? 'WARNING' : 'OK';
  }
  return { registry, scan, selection, selectionExists: exists, engine, report, root, framework };
}

const THRESHOLD = { error: 'error', critical: 'critical' };

// Throws ProtocolError if the findings contain something at or above the configured level.
// enforce: 'error' (default): errors and critical findings stop the app; 'critical': only blocked
// versions and similar do; 'off': nothing stops it (doctor still reports everything).
export function enforce(findings, level = 'error', label = 'Protocol compatibility check failed') {
  if (level === 'off') return;
  const min = SEVERITY_ORDER.indexOf(THRESHOLD[level] ?? 'error');
  const blocking = findings.filter((f) => !f.allowed && SEVERITY_ORDER.indexOf(f.severity) >= min);
  if (!blocking.length) return;
  const lines = blocking.map((f) => `[${f.severity}] ${f.message}${f.hint ? `\n      ${f.hint}` : ''}`);
  throw new ProtocolError(`${label}:\n  - ${lines.join('\n  - ')}`, {
    hint: 'Run "white doctor" for details and "white migrate" to move to a supported version. protocols.allow can grant a documented, temporary exception.',
    details: blocking,
  });
}

// What a running app sees as ctx.protocols: read-only, built once at startup.
export function createProtocolContext(state, { level = 'error', log } = {}) {
  const { registry, engine, report, scan, selection } = state;
  const known = new Set(scan.packages.map((p) => p.name));

  // Declarations of the libraries are fixed at startup; there is no API to change them.
  const library = (name) => {
    const lib = scan.packages.find((p) => p.name === name);
    if (!lib) throw new ProtocolError(`"${name}" does not declare protocols ("white" field in its package.json)`);
    return lib;
  };

  const used = {};
  for (const u of [...report.users, { protocol: 'mesh', version: '1.0' }, { protocol: 'plugin', version: '1.0' }]) (used[u.protocol] ??= new Set()).add(u.version);

  const api = {
    registry,
    report,
    fingerprint: registry.fingerprint(),
    used: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, [...v].sort()])),
    // The generation the application's own code uses (white.protocols.json "use"); undefined if not chosen
    selected: (name) => selection.use[name],
    // The generation a library uses. Fixed at startup: the same answer on every call, so a
    // library never switches generation while the app runs.
    for(name) {
      const lib = library(name);
      return Object.freeze({
        version(protocol) {
          if (!lib.protocols[protocol]) throw new ProtocolError(`${name} does not declare protocol "${protocol}"`);
          const version = engine.effectiveVersion(lib, protocol);
          const bad = engine.judge(name, protocol, version).find((f) => !f.allowed && (f.severity === 'error' || f.severity === 'critical'));
          if (bad) throw new ProtocolError(bad.message, { hint: bad.hint });
          return version;
        },
      });
    },
    supports: (protocol, version) => registry.isUsable(protocol, version) && registry.hasImplementation(protocol, version),
    assertUsable(protocol, version) {
      const bad = engine.judge('application', protocol, version).find((f) => !f.allowed && (f.severity === 'error' || f.severity === 'critical'));
      if (bad) throw new ProtocolError(bad.message, { hint: bad.hint });
    },
    // Called by the plugin loader before a plugin package is imported
    assertPlugin(packageJson, label) {
      const { library: lib, problems } = readLibraryManifest(packageJson);
      if (problems.length) throw new ProtocolError(`Plugin "${label}" has an invalid "white" field:\n  - ${problems.join('\n  - ')}`);
      if (!lib || known.has(lib.name)) return; // no declarations, or already judged at startup
      const { findings } = engine.analyzeLibrary(lib);
      for (const f of findings.filter((x) => x.severity === 'warning')) log?.warn(f.message);
      enforce(findings, level, `Plugin "${label}" is not compatible with the protocols of this app`);
    },
  };
  return Object.freeze(api);
}
