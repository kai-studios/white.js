import { compareProtocolVersions, satisfies } from './version.js';

// The Compatibility Engine answers one question: given what is installed and what the project
// has chosen, which protocol generations are in use, and is each of them acceptable?
//
// It only reads. It never changes the project, never loads library code, and never assumes
// that two versions work together because their names or numbers look alike; only declarations
// (protocol manifests, library manifests, white.protocols.json) count.
//
// A finding: { code, severity: 'info'|'warning'|'error'|'critical', subject, protocol?, version?,
//              message, hint?, allowed? }

export const SEVERITY_ORDER = ['info', 'warning', 'error', 'critical'];

const finding = (severity, code, subject, message, extra = {}) => ({ severity, code, subject, message, ...extra });

export function createCompatibilityEngine({ registry, framework, selection = { use: {}, libraries: {} }, allow = [], now = () => new Date() }) {
  const exceptions = new Map();
  for (const entry of allow) {
    const until = entry.until ? new Date(entry.until) : null;
    exceptions.set(entry.protocol, { reason: entry.reason, expired: until !== null && until < now() });
  }

  // Which generation a library uses: an explicit override in white.protocols.json, else what it requires
  const effectiveVersion = (lib, protocol) => selection.libraries?.[lib.name]?.[protocol] ?? lib.protocols[protocol].required;

  // Is this protocol version acceptable, and if not, how bad is it?
  function judge(subject, protocol, version, { optional = false } = {}) {
    const out = [];
    const ref = `${protocol}@${version}`;
    const base = { protocol, version };

    if (!registry.has(protocol)) {
      out.push(finding(optional ? 'warning' : 'error', 'protocol-unknown', subject, `${subject} uses protocol "${protocol}", which is not registered`, { ...base, hint: `Install the package that defines "${protocol}", or declare it in protocols.definitions.` }));
      return out;
    }
    const manifest = registry.get(protocol, version);
    if (!manifest) {
      out.push(finding('error', 'version-unknown', subject, `${subject} uses ${ref}, but the registry has no such version (known: ${registry.versions(protocol).map((m) => m.version).join(', ') || 'none'})`, base));
      return out;
    }

    const exception = exceptions.get(ref);
    const excused = exception && !exception.expired;
    if (exception?.expired) out.push(finding('warning', 'exception-expired', subject, `The exception for ${ref} has expired`, { ...base, hint: 'Remove it from protocols.allow, or migrate.' }));

    const advisory = manifest.advisory;
    if (manifest.status === 'blocked') {
      const why = advisory ? `${advisory.id}: ${advisory.summary}` : manifest.reason;
      const severity = advisory ? 'critical' : 'error';
      const text = `${subject} uses ${ref}, which is blocked (${why}). Updating the library is not enough while the application keeps using this protocol version`;
      out.push(
        excused
          ? finding('warning', 'blocked-allowed', subject, `${text}. Allowed by protocols.allow: ${exception.reason}`, { ...base, allowed: true, advisory })
          : finding(severity, 'blocked-version', subject, text, { ...base, advisory, hint: `Migrate to ${registry.current(protocol)?.name ? `${protocol}@${registry.current(protocol).version}` : 'a supported version'} (white migrate).` }),
      );
    } else if (manifest.status === 'removed') {
      out.push(
        excused
          ? finding('warning', 'removed-allowed', subject, `${subject} uses ${ref}, which was removed. Allowed by protocols.allow: ${exception.reason}`, { ...base, allowed: true })
          : finding('error', 'removed-version', subject, `${subject} uses ${ref}, which is no longer supported`, { ...base, hint: 'Run: white migrate' }),
      );
    } else if (manifest.status === 'deprecated') {
      out.push(finding('warning', 'deprecated-version', subject, `${subject} uses ${ref}, which is deprecated${manifest.deprecation?.message ? `: ${manifest.deprecation.message}` : ''}`, base));
    } else if (manifest.status === 'supported' && registry.current(protocol)) {
      out.push(finding('info', 'not-current', subject, `${subject} uses ${ref}; ${protocol}@${registry.current(protocol).version} is the current version`, base));
    }

    if (manifest.compatibility.white && framework && !satisfies(framework, manifest.compatibility.white)) {
      out.push(finding('error', 'framework-incompatible', subject, `${ref} requires White.js ${manifest.compatibility.white}, but this is ${framework}`, base));
    }
    if (manifest.status !== 'removed' && !registry.hasImplementation(protocol, version)) {
      out.push(finding('error', 'implementation-missing', subject, `${subject} uses ${ref}, but no installed package implements it`, { ...base, hint: `Install a package that provides ${ref} ("white.provides" in its package.json).` }));
    }
    return out;
  }

  // What would move a user from `version` to the current one
  function recommend(subject, kind, protocol, version, supported) {
    const current = registry.current(protocol);
    if (!current || current.version === version) return null;
    const usable = registry.isUsable(protocol, current.version);
    if (!usable) return null;
    const path = registry.pathTo(protocol, version, current.version);
    const canSwitch = kind === 'application' || (supported ?? []).includes(current.version);
    return {
      subject,
      kind,
      protocol,
      from: version,
      to: current.version,
      action: canSwitch ? 'switch' : 'update-library',
      path,
      migration: path === null ? 'unavailable' : path.every((e) => e.strategy === 'automatic') ? 'automatic' : 'manual',
    };
  }

  function analyzeLibrary(lib) {
    const findings = [];
    const users = [];
    const recommendations = [];
    if (lib.framework && framework && !satisfies(framework, lib.framework)) {
      findings.push(finding('error', 'library-framework-incompatible', lib.name, `${lib.name}@${lib.version} requires White.js ${lib.framework}, but this is ${framework}`));
    }
    for (const [protocol, spec] of Object.entries(lib.protocols)) {
      const version = effectiveVersion(lib, protocol);
      if (!spec.supported.includes(version)) {
        findings.push(finding('error', 'selection-unsupported', lib.name, `white.protocols.json selects ${protocol}@${version} for ${lib.name}, but it supports only ${spec.supported.join(', ')}`, { protocol, version }));
      }
      users.push({ subject: lib.name, kind: 'library', libraryVersion: lib.version, protocol, version, required: spec.required, supported: spec.supported, explicit: selection.libraries?.[lib.name]?.[protocol] !== undefined });
      findings.push(...judge(lib.name, protocol, version, { optional: spec.optional }));
      const rec = recommend(lib.name, 'library', protocol, version, spec.supported);
      if (rec) recommendations.push(rec);
    }
    return { findings, users, recommendations };
  }

  function analyze(libraries) {
    const findings = [];
    const users = [];
    const recommendations = [];

    for (const lib of libraries) {
      const r = analyzeLibrary(lib);
      findings.push(...r.findings);
      users.push(...r.users);
      recommendations.push(...r.recommendations);
    }
    for (const [protocol, version] of Object.entries(selection.use ?? {})) {
      users.push({ subject: 'application', kind: 'application', protocol, version, supported: [version], explicit: true });
      findings.push(...judge('application', protocol, version));
      const rec = recommend('application', 'application', protocol, version);
      if (rec) recommendations.push(rec);
    }

    // Protocols that allow one generation per process: every user must agree
    for (const protocol of new Set(users.map((u) => u.protocol))) {
      const versions = registry.versions(protocol);
      if (!versions.length || versions[0].coexistence !== 'single') continue;
      const group = users.filter((u) => u.protocol === protocol);
      if (new Set(group.map((u) => u.version)).size < 2) continue;
      const common = group
        .map((u) => (u.kind === 'application' ? [u.version] : u.supported))
        .reduce((a, b) => a.filter((v) => b.includes(v)))
        .filter((v) => registry.isUsable(protocol, v))
        .sort(compareProtocolVersions);
      const list = group.map((u) => `${u.subject} ${u.version}`).join(', ');
      findings.push(
        common.length
          ? finding('warning', 'generation-mismatch', protocol, `${protocol} allows one generation per process, but the project mixes: ${list}`, { protocol, hint: `All of them support ${protocol}@${common.at(-1)}; select it for each in white.protocols.json (white migrate ${protocol}@${common.at(-1)}).` })
          : finding('error', 'generation-conflict', protocol, `${protocol} allows one generation per process, and no generation is supported by all of: ${list}`, { protocol, hint: 'Update the libraries, or remove the one that cannot support the others.' }),
      );
    }

    // A blocked or removed version with no way out
    for (const u of users) {
      const status = registry.statusOf(u.protocol, u.version);
      if ((status === 'blocked' || status === 'removed') && !recommendations.some((r) => r.subject === u.subject && r.protocol === u.protocol && r.migration !== 'unavailable')) {
        findings.push(finding('error', 'migration-unavailable', u.subject, `No migration path leads from ${u.protocol}@${u.version} to a usable version`, { protocol: u.protocol, version: u.version }));
      }
    }

    const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
    const status = summary.critical ? 'CRITICAL' : summary.error ? 'ERROR' : summary.warning ? 'WARNING' : 'OK';
    const actionable = recommendations.filter((r) => r.action === 'switch' && r.migration !== 'unavailable');
    return {
      framework,
      status,
      summary,
      findings,
      users,
      recommendations,
      migrations: { automatic: actionable.filter((r) => r.migration === 'automatic').length, manual: actionable.filter((r) => r.migration === 'manual').length },
    };
  }

  return { analyze, analyzeLibrary, judge, effectiveVersion };
}
