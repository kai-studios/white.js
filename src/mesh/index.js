import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequestError } from '../core/errors.js';
import { version } from '../core/meta.js';
import { createAuth } from './auth.js';
import { createClient, UpstreamError } from './client.js';
import { normalizeMesh, normalizePeer } from './config.js';
import { createNonceStore } from './nonces.js';
import { ConfigError } from '../core/config.js';

export { createClient, UpstreamError } from './client.js';
export { createBreaker } from './breaker.js';
export { createNonceStore } from './nonces.js';
export { signRequest, verifyRequest, SignatureError, HEADERS as MESH_HEADERS } from './sign.js';
export { normalizeMesh, meshWarnings } from './config.js';
export { requestContext } from './context.js';

const EVENT_TYPE = /^[\w.:-]{1,100}$/;
const EVENT_ID = /^[\w.-]{8,100}$/;
const EVENT_TTL = 60 * 60_000; // how long a delivered event id is remembered (duplicates are ignored)

const matches = (pattern, type) =>
  pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));

// Everything one service needs to live among others: who may call it, who it calls,
// events, discovery and health of its peers. Created by createApp when `mesh` is configured
// and available as ctx.mesh.
export function createMesh(config, ctx) {
  const opts = normalizeMesh(config.mesh);
  if (!opts) return null;
  const log = ctx.log;

  const lifetime = new AbortController(); // ends outgoing calls on shutdown
  ctx.onClose?.(() => lifetime.abort(new Error('shutting down')));

  const peerConfigs = new Map(Object.entries(opts.peers));
  const clients = new Map();
  const known = new Set([...peerConfigs.keys(), ...opts.accept]);
  const nonces = opts.nonces ?? createNonceStore();
  const seenEvents = createNonceStore();
  const handlers = [];

  // The secret shared with a caller; only services we know about may call us
  const secretFor = (from) => (known.has(from) ? (peerConfigs.get(from)?.secret ?? opts.secret) : undefined);
  const auth = createAuth({ name: opts.name, secretFor, skew: opts.skew, nonces });

  const make = (cfg) =>
    createClient({ ...cfg, from: opts.name, maxResponse: opts.maxResponse, log, signal: lifetime.signal });

  function peer(name) {
    if (!peerConfigs.has(name)) throw new TypeError(`Unknown peer "${name}". Known peers: ${[...peerConfigs.keys()].join(', ') || 'none'}`);
    if (!clients.has(name)) clients.set(name, make(peerConfigs.get(name)));
    return clients.get(name);
  }

  // Add or replace a peer at runtime (service discovery, tests). Same fields as in the config.
  function addPeer(name, spec) {
    const problems = [];
    const cfg = normalizePeer(name, spec, opts.shared, problems);
    if (problems.length) throw new ConfigError(`Invalid peer:\n  - ${problems.join('\n  - ')}`);
    peerConfigs.set(name, cfg);
    clients.delete(name);
    known.add(name);
    return peer(name);
  }

  function removePeer(name) {
    clients.delete(name);
    peerConfigs.delete(name);
    if (!opts.accept.includes(name)) known.delete(name);
  }

  // Change only the address of a peer, keeping its other settings
  function setPeerUrl(name, url) {
    const cfg = peerConfigs.get(name);
    if (!cfg) throw new TypeError(`Unknown peer "${name}"`);
    return addPeer(name, { ...cfg, url, secret: cfg.own ? cfg.secret : undefined });
  }

  // ── Health ─────────────────────────────────────────────────────────────

  async function ping(name, { timeout = '2s' } = {}) {
    const client = peer(name);
    const started = performance.now();
    try {
      const res = await client.get('/_white/ping', { retries: 0, breaker: false, timeout });
      const ms = Math.round(performance.now() - started);
      if (res.ok && res.json?.ok) return { name, url: client.url, ok: true, ms, version: res.json.version, breaker: client.breaker?.state };
      const hint = res.status === 401 ? 'rejected our signature: check that both sides use the same names and secret' : `answered ${res.status}`;
      return { name, url: client.url, ok: false, ms, error: hint, breaker: client.breaker?.state };
    } catch (err) {
      return { name, url: client.url, ok: false, ms: Math.round(performance.now() - started), error: err.message, breaker: client.breaker?.state };
    }
  }

  const status = () => Promise.all([...peerConfigs.keys()].map((name) => ping(name)));

  // Checks for config.health: peers marked `required: true` must answer for /ready to pass
  function readinessChecks() {
    const checks = {};
    for (const [name, cfg] of peerConfigs) {
      if (!cfg.required) continue;
      checks[`mesh:${name}`] = async () => {
        const result = await ctx.cache.wrap(`mesh:ready:${name}`, async () => {
          const r = await ping(name);
          if (!r.ok) throw new Error(r.error);
          return r;
        }, '5s');
        return result;
      };
    }
    return checks;
  }

  // ── Events ─────────────────────────────────────────────────────────────

  // mesh.on('user.created', (event) => ...)   event: { id, type, data, from, at }
  // Patterns: exact type, "user.*" (prefix) or "*". Returns a function that removes the handler.
  function on(pattern, handler) {
    if (typeof handler !== 'function') throw new TypeError('mesh.on: handler must be a function');
    const entry = { pattern, handler };
    handlers.push(entry);
    return () => {
      const i = handlers.indexOf(entry);
      if (i >= 0) handlers.splice(i, 1);
    };
  }

  // Sends an event to peers (all with `events` on, or the ones in `to`). Delivery is retried
  // and receivers ignore duplicates, so each handler runs once per event.
  // Resolves to { id, delivered: [...], failed: [{ peer, error }] }; with `wait: false` it
  // returns at once with { id, queued } and failures are only logged. There is no persistent
  // outbox: an event is lost if this process dies before it is delivered.
  async function emit(type, data, { to, wait = true, timeout } = {}) {
    if (!EVENT_TYPE.test(type)) throw new TypeError(`Invalid event type ${JSON.stringify(type)}`);
    const targets = to ? [].concat(to) : [...peerConfigs].filter(([, cfg]) => cfg.events).map(([name]) => name);
    for (const target of targets) peer(target); // unknown name: fail now
    const event = { id: crypto.randomUUID(), type, data, at: new Date().toISOString() };

    const send = async (target) => {
      try {
        const res = await peer(target).post('/_white/events', { json: event, idempotent: true, retries: 3, retryStatus: [500], timeout });
        if (!res.ok) throw new UpstreamError(target, `answered ${res.status}`, { upstreamStatus: res.status });
        return { peer: target, ok: true };
      } catch (err) {
        log.warn({ peer: target, event: type, err: err.message }, 'Event delivery failed');
        return { peer: target, ok: false, error: err.message };
      }
    };

    const run = Promise.all(targets.map(send));
    if (!wait) return { id: event.id, queued: targets };
    const results = await run;
    return {
      id: event.id,
      delivered: results.filter((r) => r.ok).map((r) => r.peer),
      failed: results.filter((r) => !r.ok).map(({ peer: p, error }) => ({ peer: p, error })),
    };
  }

  async function receive(req, res) {
    const { id, type, data, at } = req.body ?? {};
    if (typeof id !== 'string' || !EVENT_ID.test(id)) throw new BadRequestError('Invalid event id');
    if (typeof type !== 'string' || !EVENT_TYPE.test(type)) throw new BadRequestError('Invalid event type');

    const key = `${req.service.name}:${id}`;
    if (!seenEvents.claim(key, EVENT_TTL)) return res.json({ ok: true, duplicate: true });
    try {
      const event = { id, type, data, from: req.service.name, at };
      const matching = handlers.filter((h) => matches(h.pattern, type));
      for (const { handler } of matching) await handler(event, { req });
      res.json({ ok: true, handled: matching.length });
    } catch (err) {
      seenEvents.release(key); // let the sender's retry run the handlers again
      throw err;
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  const isInternal = (req) => {
    const p = req.originalUrl.split('?')[0];
    return p.startsWith('/_white/') || opts.protect.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
  };

  // Mounted by createApp after the body parsers and before plugins and routes
  function mount(app) {
    for (const prefix of opts.protect) app.use(prefix, auth());
    app.get('/_white/ping', auth(), (req, res) => res.json({ ok: true, service: opts.name, version, time: new Date().toISOString() }));
    app.get('/_white/manifest', auth(), (req, res) => {
      let appInfo = {};
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'));
        appInfo = { name: pkg.name, version: pkg.version };
      } catch {
        // no package.json: leave it out
      }
      res.json({
        service: opts.name,
        framework: { name: 'white-js', version },
        app: appInfo,
        uptime: Math.round(process.uptime()),
        routes: ctx.routes.map(({ method, path: p }) => ({ method, path: p })),
        events: handlers.map((h) => h.pattern),
        peers: [...peerConfigs.keys()],
        meta: opts.meta,
      });
    });
    app.post('/_white/events', auth(), receive);
  }

  return {
    name: opts.name,
    auth,
    peer,
    addPeer,
    removePeer,
    setPeerUrl,
    get peers() {
      return [...peerConfigs.keys()];
    },
    ping,
    status,
    readinessChecks,
    on,
    emit,
    isInternal,
    mount,
  };
}

// Route-level helper that does not need ctx:  router.get('/', serviceAuth({ allow: ['web'] }), ...)
export const serviceAuth = (options) => (req, res, next) => {
  const mesh = req.app.locals.mesh;
  if (!mesh) return next(new Error('serviceAuth needs "mesh" in white.config.js'));
  return mesh.auth(options)(req, res, next);
};
