import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError } from './white-error.js';
import { normalizeTrustProxy } from './proxy.js';
import { normalizeRequestId } from './request-id.js';

export { ConfigError };

// Defaults: a site's white.config.js only needs to contain what it changes
export const defaults = {
  port: null, // PORT env variable, otherwise 3000
  host: null, // address to listen on; null: all interfaces
  locale: 'en', // used by it.w.date() and it.w.number()
  dev: { reload: true }, // refresh the browser when views, styles or server files change
  shutdownTimeout: 10_000, // ms for the WHOLE shutdown: running requests and onClose handlers
  trustProxy: false, // behind a proxy: a hop count (1), subnets ('10.0.0.0/8') or 'loopback'; `true` is refused
  requestId: { header: 'x-request-id', accept: 'trusted' }, // who may choose request ids, see the README
  protocols: { enforce: 'error', allow: [], block: [], definitions: [] }, // protocol compatibility, see docs/protocols.md
  dirs: {
    routes: 'server/routes',
    views: 'app/views',
    public: 'app/public',
    meta: 'server/meta',
    migrations: 'server/migrations', // your own protocol migrations, see docs/migrations.md
  },
  view: { engine: 'eta' },
  log: { level: null }, // LOG_LEVEL env variable, otherwise "info"
  env: { required: [] }, // variables that must exist, checked at startup
  health: { path: '/health', readyPath: '/ready', checks: {} }, // false disables
  security: {
    helmet: true, // false disables security headers; an object is passed to helmet
    csp: true, // true: defaults + per-request nonce; false: off; object: directives
    bodyLimit: '100kb',
    rateLimit: { windowMs: 60_000, limit: 300, api: { limit: 60 } }, // false disables
    origin: { allowed: [] }, // CSRF origin check; false disables
  },
  mesh: false, // service-to-service infrastructure, see the README ("Services"); an object enables it
  plugins: [],
};

const isPlain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    out[key] = isPlain(base[key]) && isPlain(value) ? merge(base[key], value) : value;
  }
  return out;
}

const ENFORCE = ['error', 'critical', 'off'];

// Rejects settings that would silently do the wrong thing
function validate(config) {
  const problems = [];
  if (!Number.isFinite(config.shutdownTimeout) || config.shutdownTimeout <= 0) problems.push('shutdownTimeout must be a positive number of milliseconds');
  if (!ENFORCE.includes(config.protocols?.enforce)) problems.push(`protocols.enforce must be one of: ${ENFORCE.join(', ')}`);
  for (const key of ['allow', 'block', 'definitions']) {
    if (!Array.isArray(config.protocols?.[key])) problems.push(`protocols.${key} must be an array`);
  }
  for (const entry of config.protocols?.allow ?? []) {
    if (typeof entry?.protocol !== 'string' || typeof entry?.reason !== 'string' || !entry.reason.trim()) {
      problems.push('every protocols.allow entry needs "protocol" (e.g. "meta@2.0") and a written "reason"');
    } else if (entry.until !== undefined && Number.isNaN(Date.parse(entry.until))) {
      problems.push(`protocols.allow "${entry.protocol}": "until" must be a date such as 2027-01-31`);
    }
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

export function resolveConfig(user = {}) {
  const config = merge(defaults, user);
  config.port ??= Number(process.env.PORT) || 3000;
  normalizeTrustProxy(config.trustProxy); // throws ConfigError when unsafe or malformed
  normalizeRequestId(config.requestId);
  validate(config);
  return config;
}

// Loads .env into process.env (existing variables are not overwritten)
export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function assertEnv(required = []) {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Reads .env and white.config.js from the project root; both are optional
export async function loadConfig(root = process.cwd()) {
  loadEnv(root);
  const file = path.join(root, 'white.config.js');
  const user = fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : {};
  const config = resolveConfig(user);
  assertEnv(config.env?.required);
  return config;
}
