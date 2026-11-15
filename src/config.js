import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Thrown for problems the user must fix (printed without a stack trace)
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Defaults: a site's white.config.js only needs to contain what it changes
export const defaults = {
  port: null, // PORT env variable, otherwise 3000
  trustProxy: false, // behind a proxy set the number of hops, e.g. 1
  dirs: {
    routes: 'server/routes',
    views: 'app/views',
    public: 'app/public',
    meta: 'server/meta',
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

export function resolveConfig(user = {}) {
  const config = merge(defaults, user);
  config.port ??= Number(process.env.PORT) || 3000;
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
