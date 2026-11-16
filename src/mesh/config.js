import { ConfigError } from '../core/config.js';
import { duration } from '../utils/duration.js';
import { SERVICE_NAME } from './sign.js';

const MIN_SECRET = 16;
const PATH_PREFIX = /^\/[\w\-./]*$/;

const dur = (value, label, problems) => {
  try {
    return duration(value);
  } catch {
    problems.push(`${label} is not a valid duration (use 1500 or "30s", "5m")`);
  }
};

// Settings shared by every peer unless the peer overrides them
const peerDefaults = { timeout: '5s', retries: 2, retryDelay: '100ms', required: false, events: true, breaker: { threshold: 5, cooldown: '30s' } };

export function normalizePeer(name, raw, shared, problems) {
  const label = `mesh.peers.${name}`;
  if (!SERVICE_NAME.test(name)) problems.push(`${label}: the name may contain letters, numbers, ".", "_" and "-" (up to 63 characters)`);
  const spec = typeof raw === 'string' ? { url: raw } : { ...raw };

  let url;
  try {
    url = new URL(spec.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    problems.push(`${label}.url must be an http(s) URL`);
  }

  const secret = spec.secret ?? shared.secret;
  if (!secret) problems.push(`${label}: no secret. Set ${label}.secret or mesh.secret`);
  else if (typeof secret !== 'string' || secret.length < MIN_SECRET) problems.push(`${label}: the secret must be a string of at least ${MIN_SECRET} characters (white mesh keygen makes one)`);

  const merged = { ...peerDefaults, ...shared.defaults, ...spec };
  if (merged.breaker !== false) merged.breaker = { ...peerDefaults.breaker, ...shared.defaults?.breaker, ...merged.breaker };
  const timeout = dur(merged.timeout, `${label}.timeout`, problems);
  const retryDelay = dur(merged.retryDelay, `${label}.retryDelay`, problems);
  if (!Number.isInteger(merged.retries) || merged.retries < 0 || merged.retries > 10) problems.push(`${label}.retries must be an integer from 0 to 10`);
  if (merged.breaker) dur(merged.breaker.cooldown, `${label}.breaker.cooldown`, problems);

  return {
    name,
    url: url?.href,
    secret,
    own: spec.secret !== undefined,
    timeout,
    retries: merged.retries,
    retryDelay,
    required: Boolean(merged.required),
    events: merged.events !== false,
    breaker: merged.breaker,
  };
}

// Checks `mesh` from white.config.js and fills in defaults. Every problem is reported at once.
//
//   mesh: {
//     name: 'web',                         // this service; peers use this name to address it
//     secret: process.env.MESH_SECRET,     // optional shared secret (prefer one per peer)
//     peers: {
//       billing: { url: 'http://billing:3000', secret: process.env.BILLING_SECRET, required: true },
//       users: 'http://users:3000',        // shorthand: url only, uses mesh.secret
//     },
//     accept: ['admin'],                   // services allowed to call us that we do not call
//     protect: ['/internal', '/api/internal'],  // URL prefixes that only signed services may reach
//     skew: '60s', timeout: '5s', retries: 2, breaker: { threshold: 5, cooldown: '30s' },
//     meta: { region: 'eu' },              // shown in /_white/manifest
//   }
export function normalizeMesh(raw) {
  if (!raw) return null;
  if (typeof raw !== 'object') throw new ConfigError('mesh must be an object');
  const problems = [];

  if (!raw.name || !SERVICE_NAME.test(String(raw.name))) problems.push('mesh.name is required: letters, numbers, ".", "_" and "-" (up to 63 characters)');
  if (raw.secret !== undefined && (typeof raw.secret !== 'string' || raw.secret.length < MIN_SECRET)) {
    problems.push(`mesh.secret must be a string of at least ${MIN_SECRET} characters (white mesh keygen makes one)`);
  }

  const shared = {
    secret: raw.secret,
    defaults: { timeout: raw.timeout, retries: raw.retries, retryDelay: raw.retryDelay, breaker: raw.breaker },
  };
  for (const key of Object.keys(shared.defaults)) if (shared.defaults[key] === undefined) delete shared.defaults[key];

  const peers = {};
  for (const [name, spec] of Object.entries(raw.peers ?? {})) {
    if (name === raw.name) problems.push(`mesh.peers.${name}: a service cannot be its own peer`);
    peers[name] = normalizePeer(name, spec, shared, problems);
  }

  const accept = [...(raw.accept ?? [])];
  for (const name of accept) {
    if (!SERVICE_NAME.test(String(name))) problems.push(`mesh.accept: "${name}" is not a valid service name`);
    else if (!raw.secret && !peers[name]) problems.push(`mesh.accept: "${name}" needs mesh.secret (or list it in mesh.peers with its own secret)`);
  }

  const protect = raw.protect ?? ['/internal', '/api/internal'];
  for (const prefix of protect) if (!PATH_PREFIX.test(prefix) || prefix.length > 1 && prefix.endsWith('/')) problems.push(`mesh.protect: "${prefix}" must be a path prefix like "/internal"`);

  const skew = dur(raw.skew ?? '60s', 'mesh.skew', problems);
  const maxResponse = raw.maxResponse ?? 5 * 1024 * 1024;
  if (raw.nonces && typeof raw.nonces.claim !== 'function') problems.push('mesh.nonces must have a claim(key, ttlMs) method');

  if (problems.length) throw new ConfigError(`Invalid mesh configuration:\n  - ${problems.join('\n  - ')}`);
  return { name: raw.name, secret: raw.secret, shared, peers, accept, protect, skew, maxResponse, nonces: raw.nonces, meta: raw.meta ?? {} };
}

// Things that work but are worth fixing. Used by `white doctor`.
export function meshWarnings(mesh) {
  const warnings = [];
  const secrets = [mesh.secret, ...Object.values(mesh.peers).filter((p) => p.own).map((p) => p.secret)].filter(Boolean);
  for (const secret of secrets) if (secret.length < 32) warnings.push('a secret is shorter than 32 characters');
  if (mesh.secret && Object.keys(mesh.peers).length > 1) {
    warnings.push('one shared secret for several services: any of them can impersonate any other. Give each peer its own secret');
  }
  for (const peer of Object.values(mesh.peers)) {
    const host = new URL(peer.url).hostname;
    const local = host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !host.includes('.');
    if (peer.url.startsWith('http://') && !local) warnings.push(`${peer.name} is called over plain http on a public name: bodies are signed but not encrypted`);
  }
  return [...new Set(warnings)];
}
