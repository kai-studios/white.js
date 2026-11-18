import net from 'node:net';
import { ConfigError } from './white-error.js';

// Validates `trustProxy` and turns it into the value Express understands.
//
//   false                       trust nobody (default): the client address is the socket address
//   1                           trust one hop (a single reverse proxy in front of the app)
//   '10.0.0.0/8'                trust these addresses or subnets (string, comma list or array)
//   ['loopback', '10.1.2.3']    keywords: loopback, linklocal, uniquelocal
//   { hops: 1 } | { proxies: [...] }   the same, spelled out
//   (ip, hop) => boolean        full control
//
// `true` is refused: it makes Express believe every X-Forwarded-* header, so any client could
// forge its IP address and the protocol of the connection.
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 32;

function checkEntry(entry, problems) {
  if (KEYWORDS.has(entry)) return;
  const [addr, prefix, ...rest] = entry.split('/');
  const family = net.isIP(addr);
  if (!family || rest.length) return problems.push(`"${entry}" is not an IP address, subnet (10.0.0.0/8) or keyword (${[...KEYWORDS].join(', ')})`);
  if (prefix === undefined) return;
  const max = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefix) || Number(prefix) > max) return problems.push(`"${entry}": the prefix length must be 0-${max}`);
  if (Number(prefix) === 0) problems.push(`"${entry}" would trust every address, which is the same as trustProxy: true`);
}

function list(value) {
  const items = (Array.isArray(value) ? value : String(value).split(',')).map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '');
  const problems = [];
  if (!items.length) problems.push('the list of trusted proxies is empty (use false to trust nobody)');
  for (const item of items) {
    if (typeof item !== 'string') problems.push(`${JSON.stringify(item)} is not a string`);
    else checkEntry(item, problems);
  }
  if (problems.length) throw new ConfigError(`Invalid trustProxy:\n  - ${problems.join('\n  - ')}`);
  return items;
}

// Returns { mode, setting, description }. `setting` is for app.set('trust proxy', setting).
export function normalizeTrustProxy(value) {
  if (value === undefined || value === null || value === false) return { mode: 'off', setting: false, description: 'no proxy is trusted' };

  if (value === true) {
    throw new ConfigError('Invalid trustProxy: true trusts every X-Forwarded-* header, so any client could forge its IP address and protocol', {
      hint: 'Use a hop count (trustProxy: 1), or list your proxies (trustProxy: ["10.0.0.0/8"] or "loopback").',
    });
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > MAX_HOPS) throw new ConfigError(`Invalid trustProxy: the hop count must be an integer from 0 to ${MAX_HOPS}`);
    return value === 0
      ? { mode: 'off', setting: false, description: 'no proxy is trusted' }
      : { mode: 'hops', setting: value, hops: value, description: `${value} proxy hop${value === 1 ? '' : 's'}` };
  }
  if (typeof value === 'function') return { mode: 'function', setting: value, description: 'custom function' };
  if (typeof value === 'string' || Array.isArray(value)) {
    const proxies = list(value);
    return { mode: 'addresses', setting: proxies, proxies, description: proxies.join(', ') };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'hops') return normalizeTrustProxy(value.hops);
    if (keys.length === 1 && keys[0] === 'proxies') return { mode: 'addresses', ...(({ proxies }) => ({ proxies, setting: proxies, description: proxies.join(', ') }))({ proxies: list(value.proxies) }) };
    throw new ConfigError('Invalid trustProxy: an object must have exactly one of "hops" or "proxies"');
  }
  throw new ConfigError(`Invalid trustProxy: unsupported value of type ${typeof value}`);
}

// Is the machine that opened this connection a trusted proxy? Always false when none is configured.
export function fromTrustedProxy(req) {
  const trust = req.app.get('trust proxy fn');
  const address = req.socket?.remoteAddress;
  return Boolean(address && typeof trust === 'function' && trust(address, 0));
}
