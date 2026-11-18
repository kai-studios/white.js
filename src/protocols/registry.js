import crypto from 'node:crypto';
import { ProtocolError } from '../core/white-error.js';
import { validateProtocolManifest, STATUSES } from './manifest.js';
import { compareProtocolVersions, parseRef } from './version.js';

// The registry of protocol versions known to one app: what exists, what status it has, how
// versions relate, and who implements them.
//
// It is an ordinary object, created per app (no module-level state), filled while the app
// starts, then frozen. After freeze() every mutating method throws and everything it returns
// is immutable. It can be serialised (toJSON) and carries a fingerprint, so separate processes
// or services can check that they see the same protocols.
export class ProtocolRegistry {
  #versions = new Map(); // name -> Map(version -> { manifest, source })
  #implementations = new Map(); // 'name@version' -> [{ source, package?, packageVersion? }]
  #frozen = false;

  get frozen() {
    return this.#frozen;
  }

  #mutable() {
    if (this.#frozen) throw new ProtocolError('The protocol registry is frozen: it cannot be changed after the app has started');
  }

  // Registers one version of a protocol. Registering the same manifest again is harmless;
  // registering a different one for an existing name@version is an error.
  register(input, { source = 'unknown' } = {}) {
    this.#mutable();
    const { manifest, problems } = validateProtocolManifest(input);
    if (!manifest) throw new ProtocolError(`Invalid protocol manifest from ${source}:\n  - ${problems.join('\n  - ')}`);
    const versions = this.#versions.get(manifest.name) ?? new Map();
    const existing = versions.get(manifest.version);
    if (existing) {
      if (JSON.stringify(existing.manifest) === JSON.stringify(manifest)) return existing.manifest;
      throw new ProtocolError(`${manifest.name}@${manifest.version} is defined twice with different content (by ${existing.source} and ${source})`, {
        hint: 'Protocol versions are immutable once published. Publish the change as a new version.',
      });
    }
    versions.set(manifest.version, { manifest, source });
    this.#versions.set(manifest.name, versions);
    if (manifest.implementation === 'builtin') this.addImplementation(manifest.name, manifest.version, { source: 'builtin' });
    return manifest;
  }

  registerAll(list, options) {
    return list.map((m) => this.register(m, options));
  }

  // Changes the status of a version (for example to block it). Returns the new manifest.
  setStatus(name, version, status, { reason } = {}) {
    this.#mutable();
    if (!STATUSES.includes(status)) throw new ProtocolError(`Unknown status "${status}". Expected: ${STATUSES.join(', ')}`);
    const entry = this.#versions.get(name)?.get(version);
    if (!entry) throw new ProtocolError(`Cannot change the status of ${name}@${version}: it is not registered`);
    const raw = { ...entry.manifest, status, ...(status === 'blocked' && !entry.manifest.advisory && { reason: reason ?? entry.manifest.reason ?? 'blocked by project policy' }) };
    const { manifest, problems } = validateProtocolManifest(raw);
    if (!manifest) throw new ProtocolError(`Cannot set status of ${name}@${version}: ${problems.join('; ')}`);
    entry.manifest = manifest;
    return manifest;
  }

  addImplementation(name, version, info) {
    this.#mutable();
    const key = `${name}@${version}`;
    const list = this.#implementations.get(key) ?? [];
    if (!list.some((i) => i.source === info.source && i.package === info.package)) list.push(Object.freeze({ ...info }));
    this.#implementations.set(key, list);
  }

  freeze() {
    this.#frozen = true;
    return this;
  }

  // ── Queries ──

  names() {
    return [...this.#versions.keys()].sort();
  }

  has(name, version) {
    return version === undefined ? this.#versions.has(name) : Boolean(this.#versions.get(name)?.has(version));
  }

  get(name, version) {
    return this.#versions.get(name)?.get(version)?.manifest;
  }

  sourceOf(name, version) {
    return this.#versions.get(name)?.get(version)?.source;
  }

  // Manifests of a protocol, newest first
  versions(name) {
    return [...(this.#versions.get(name)?.values() ?? [])].map((e) => e.manifest).sort((a, b) => compareProtocolVersions(b.version, a.version));
  }

  // Parses "meta@3.0" and looks it up
  find(ref) {
    const { name, version } = parseRef(ref);
    return this.get(name, version);
  }

  statusOf(name, version) {
    return this.get(name, version)?.status;
  }

  // The newest version with status "current" (undefined when there is none)
  current(name) {
    return this.versions(name).find((m) => m.status === 'current');
  }

  // A version can be used unless it is unknown, blocked or removed
  isUsable(name, version) {
    const status = this.statusOf(name, version);
    return status !== undefined && status !== 'blocked' && status !== 'removed';
  }

  implementations(name, version) {
    return this.#implementations.get(`${name}@${version}`) ?? [];
  }

  hasImplementation(name, version) {
    return this.implementations(name, version).length > 0;
  }

  // Do two versions of a protocol interoperate? Only if one of them says so (compatibility.protocols).
  // Never inferred from numbers, and never transitive: meta@2.0 ~ meta@2.1 ~ meta@2.2 says nothing about 2.0 and 2.2.
  interoperable(name, a, b) {
    if (a === b) return this.has(name, a);
    const [x, y] = [this.get(name, a), this.get(name, b)];
    return Boolean(x && y && (x.compatibility.protocols.includes(`${name}@${b}`) || y.compatibility.protocols.includes(`${name}@${a}`)));
  }

  // Migration steps declared between versions: [{ from, to, strategy, id, integrity }]
  migrationEdges(name) {
    const edges = [];
    for (const m of this.versions(name)) {
      if (!m.migration) continue;
      edges.push({ protocol: name, from: parseRef(m.migration.from).version, to: m.version, strategy: m.migration.strategy, id: m.migration.id ?? `${name}-${parseRef(m.migration.from).version}-to-${m.version}`, integrity: m.migration.integrity, source: this.sourceOf(name, m.version) });
    }
    return edges;
  }

  // The shortest chain of declared migrations from one version to another, or null.
  // [] means "already there".
  pathTo(name, from, to) {
    if (from === to) return [];
    const edges = this.migrationEdges(name);
    const queue = [[from, []]];
    const seen = new Set([from]);
    while (queue.length) {
      const [at, path] = queue.shift();
      for (const edge of edges.filter((e) => e.from === at)) {
        if (seen.has(edge.to)) continue;
        if (!this.isUsable(name, edge.to)) continue;
        const next = [...path, edge];
        if (edge.to === to) return next;
        seen.add(edge.to);
        queue.push([edge.to, next]);
      }
    }
    return null;
  }

  // ── Serialisation ──

  toJSON() {
    return {
      protocols: this.names().map((name) => ({
        name,
        versions: this.versions(name).map((manifest) => ({ ...manifest, source: this.sourceOf(name, manifest.version), implementations: this.implementations(name, manifest.version).map((i) => i.package ?? i.source) })),
      })),
    };
  }

  // Same protocols, versions, statuses and implementations => same fingerprint
  fingerprint() {
    const canonical = JSON.stringify(
      this.names().map((n) => [n, this.versions(n).map((m) => [m.version, m.status, m.compatibility, m.replaces ?? null, m.migration ?? null, m.coexistence, this.implementations(n, m.version).map((i) => i.package ?? i.source).sort()])]),
    );
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }
}
