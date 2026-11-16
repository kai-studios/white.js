import { ConfigError } from './config.js';

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

const parsers = {
  string: (v) => v,
  number: (v) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined),
  integer: (v) => (/^-?\d+$/.test(v.trim()) ? Number(v) : undefined),
  port: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 65535 ? Number(v) : undefined),
  boolean: (v) => (TRUE.has(v.trim().toLowerCase()) ? true : FALSE.has(v.trim().toLowerCase()) ? false : undefined),
  url: (v) => {
    try {
      return new URL(v).href;
    } catch {
      return undefined;
    }
  },
};

// Reads and checks environment variables in one place and returns a typed object.
// Every problem is reported at once.
//
//   const env = defineEnv({
//     PORT: 'port',                               // type name
//     DATABASE_URL: 'url',
//     DEBUG: { type: 'boolean', default: false }, // with a default
//     LEVEL: ['debug', 'info', 'warn'],           // one of
//     SENTRY_DSN: { type: 'url', optional: true },
//   });
//
// Types: string (default), number, integer, port, boolean, url.
export function defineEnv(spec, source = process.env) {
  const result = {};
  const problems = [];

  for (const [name, raw] of Object.entries(spec)) {
    const rule = typeof raw === 'string' ? { type: raw } : Array.isArray(raw) ? { oneOf: raw } : { ...raw };
    const type = rule.type ?? 'string';
    if (!(type in parsers)) throw new TypeError(`defineEnv: unknown type "${type}" for ${name}`);

    const value = source[name];
    if (value === undefined || value === '') {
      if ('default' in rule) result[name] = rule.default;
      else if (rule.optional) result[name] = undefined;
      else problems.push(`${name} is required`);
      continue;
    }

    const parsed = parsers[type](value);
    if (parsed === undefined) {
      problems.push(`${name} must be ${type === 'url' ? 'a valid URL' : `a ${type}`}`);
    } else if (rule.oneOf && !rule.oneOf.includes(parsed)) {
      problems.push(`${name} must be one of: ${rule.oneOf.join(', ')}`);
    } else {
      result[name] = parsed;
    }
  }

  if (problems.length) {
    throw new ConfigError(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }
  return Object.freeze(result);
}
