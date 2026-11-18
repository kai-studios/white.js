import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutes, loadPlugins } from './loader.js';
import { createLogger } from './logger.js';
import { etaEngine } from '../http/views.js';
import { errorPage } from '../http/pages.js';
import { securityHeaders, originCheck, rateLimiters, bodyParsers } from '../http/security.js';
import { json, url, createAsset, createHelpers } from '../http/helpers.js';
import { createCache } from '../utils/cache.js';
import { liveReload } from '../dev/livereload.js';
import { printBanner } from '../ui/banner.js';
import { createMesh } from '../mesh/index.js';
import { requestContext } from '../mesh/context.js';
import { ResourceStack } from './resources.js';
import { createLifecycle, STATE } from './lifecycle.js';
import { normalizeTrustProxy } from './proxy.js';
import { createRequestId } from './request-id.js';
import { loadProtocolState, createProtocolContext, enforce } from '../protocols/index.js';

// Builds the app. If anything fails while it is being built (a plugin throws, a route file is
// invalid, a protocol is blocked) everything that was already opened is closed again, in reverse
// order, and the original error is thrown: a failed start leaves nothing behind.
export async function createApp(config, root = process.cwd()) {
  const dev = process.env.NODE_ENV !== 'production';
  const abs = (p) => path.resolve(root, p);
  const log = createLogger(config, dev);
  const resources = new ResourceStack({ log });
  const app = express();
  let lifecycle;

  // ctx is handed to every route and plugin.
  //   ctx.cache      shared in-memory cache
  //   ctx.onClose(fn, { name }?)  registers cleanup (close a database, flush a queue). Handlers run
  //                  last-registered-first on shutdown and when start-up fails. Registered after
  //                  shutdown has finished, the handler runs immediately.
  //   ctx.protocols  protocol registry and compatibility report (read-only)
  //   ctx.state      'created' | 'starting' | 'running' | 'stopping' | 'stopped'
  const ctx = {
    config,
    root,
    dev,
    abs,
    log,
    routes: [],
    cache: createCache(),
    onClose: (fn, options) => resources.add(fn, options),
    get state() {
      return lifecycle?.state ?? 'created';
    },
  };

  try {
    await build();
  } catch (err) {
    // roll back whatever the plugins opened before the failure
    const result = await resources.closeAll({ timeoutMs: config.shutdownTimeout });
    if (result.errors.length || result.pending.length) {
      log.error({ failed: result.errors.map((e) => e.name), unfinished: result.pending }, 'Some resources could not be released while rolling back a failed start');
      Object.defineProperty(err, 'cleanupErrors', { value: result.errors, enumerable: false });
    }
    throw err;
  }

  async function build() {
    // Which protocol generations does this project use, and is that acceptable? Read from
    // package.json files only; blocked versions stop the app here, before any plugin runs.
    const protocolState = loadProtocolState(config, root);
    ctx.protocols = createProtocolContext(protocolState, { level: config.protocols.enforce, log });
    for (const f of protocolState.report.findings.filter((x) => x.severity === 'warning')) log.warn({ protocol: f.protocol }, f.message);
    enforce(protocolState.report.findings, config.protocols.enforce);

    // Service-to-service infrastructure (signed calls, peers, events); only when `mesh` is configured
    ctx.mesh = createMesh(config, ctx) ?? undefined;

    const viewsDir = abs(config.dirs.views);
    const publicDir = abs(config.dirs.public);
    const hasErrorView = fs.existsSync(path.join(viewsDir, 'error.eta'));

    app.disable('x-powered-by');
    app.locals.dev = dev;
    app.locals.mesh = ctx.mesh;
    // Template helpers: it.w.json(data), it.w.url(value), it.w.asset('/css/style.css'),
    // it.w.date(), number(), truncate(), classes(), active(), slug()
    app.locals.w = { json, url, asset: createAsset(publicDir, dev), ...createHelpers(config.locale) };
    // Never `true`: see normalizeTrustProxy. Default: nobody is trusted, so X-Forwarded-* is ignored.
    app.set('trust proxy', normalizeTrustProxy(config.trustProxy).setting);

    // While shutting down, tell clients not to reuse their connections
    app.use((req, res, next) => {
      if (lifecycle?.state === STATE.STOPPING) res.set('Connection', 'close');
      next();
    });

    // Per-request context: id, logger, CSP nonce, safe cookie helper
    app.use(createRequestId(config.requestId, { log, app }));
    app.use((req, res, next) => {
      res.locals.nonce = crypto.randomBytes(16).toString('base64');
      res.locals.path = req.path; // current path for templates: it.path
      res.secureCookie = (name, value, options = {}) =>
        res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: !dev, path: '/', ...options });
      next();
    });

    // Mounts a list of middleware (or [path, middleware] pairs); an empty list mounts nothing
    const mount = (list) => list.forEach((entry) => app.use(...[].concat(entry)));

    // `white run dev` sets NODE_ENV=development: refresh the browser when files change
    if (process.env.NODE_ENV === 'development' && config.dev?.reload !== false) liveReload(app, ctx);

    mount(securityHeaders(config, dev));
    app.use(compression());
    app.use(express.static(publicDir, { maxAge: dev ? 0 : '7d' }));

    // Request log (static files are not logged)
    const quiet = new Set([config.health?.path, config.health?.readyPath]);
    app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      const urlPath = req.path; // read now: inside a mounted router req.path is relative to the mount
      res.on('finish', () => {
        const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
        req.log[quiet.has(urlPath) ? 'debug' : 'info']({ status: res.statusCode, ms }, `${req.method} ${urlPath} ${res.statusCode} ${ms}ms`);
      });
      next();
    });

    // Health checks (before rate limits so probes are never throttled)
    if (config.health) {
      const { path: healthPath, readyPath } = config.health;
      // peers marked `required` in the mesh config must answer for /ready to pass
      const checks = { ...config.health.checks, ...ctx.mesh?.readinessChecks() };
      app.get(healthPath, (req, res) => res.json({ ok: true }));
      app.get(readyPath, async (req, res) => {
        // a stopping instance leaves the load balancer first
        if (lifecycle?.state === STATE.STOPPING) return res.status(503).json({ ok: false, stopping: true });
        const failed = [];
        await Promise.all(
          Object.entries(checks).map(async ([name, check]) => {
            try {
              await check();
            } catch {
              failed.push(name);
            }
          }),
        );
        res.status(failed.length ? 503 : 200).json(failed.length ? { ok: false, failed } : { ok: true });
      });
    }

    // Calls between services are authenticated by signature and have their own failure limit
    mount(rateLimiters(config, ctx.mesh && ((req) => ctx.mesh.isInternal(req))));
    mount(originCheck(config));
    mount(bodyParsers(config));

    // From here on outgoing service calls carry this request's id. Set after the body parsers:
    // they read the body in a stream callback that would lose the context.
    app.use((req, res, next) => requestContext.run({ id: req.id }, next));
    ctx.mesh?.mount(app);

    // Templates
    app.set('views', viewsDir);
    app.set('view engine', 'eta');
    app.engine('eta', etaEngine(viewsDir, { cache: !dev }));

    // Plugins first, then routes
    await loadPlugins(app, ctx);
    await loadRoutes(app, ctx);

    // Sends JSON or HTML depending on the Accept header
    const sendError = (req, res, status, message, details) => {
      res.status(status);
      if (req.accepts(['html', 'json']) === 'json') {
        return res.json({ error: message, ...(details && { details }), requestId: req.id });
      }
      if (hasErrorView) return res.render('error', { status, message });
      return res.type('html').send(errorPage(status, message));
    };

    // 404 and error handler
    app.use((req, res) => sendError(req, res, 404, 'Not found'));

    app.use((err, req, res, next) => {
      if (res.headersSent) return next(err);
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) req.log.error({ err }, 'Unhandled error');
      const message = status < 500 || dev ? err.message : 'Internal error';
      sendError(req, res, status, message, status < 500 ? err.details : undefined);
    });

  }

  lifecycle = createLifecycle({
    app,
    config,
    log,
    resources,
    onListening: () => printBanner({ port: config.port, dev, routes: ctx.routes }),
  });

  // start({ signals: false }) leaves SIGTERM/SIGINT alone (for embedding the app in a larger program)
  return { app, ctx, start: lifecycle.start, stop: lifecycle.stop, get state() { return lifecycle.state; }, get server() { return lifecycle.server; } };
}
