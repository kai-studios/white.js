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

export async function createApp(config, root = process.cwd()) {
  const dev = process.env.NODE_ENV !== 'production';
  const abs = (p) => path.resolve(root, p);
  const log = createLogger(config, dev);
  // ctx is handed to every route and plugin: ctx.cache is a shared in-memory cache
  // ctx.onClose(fn) registers cleanup (close a database, flush a queue) that runs on shutdown.
  const closers = [];
  const ctx = { config, root, dev, abs, log, routes: [], cache: createCache(), onClose: (fn) => closers.push(fn) };

  const viewsDir = abs(config.dirs.views);
  const publicDir = abs(config.dirs.public);
  const hasErrorView = fs.existsSync(path.join(viewsDir, 'error.eta'));

  const app = express();
  app.disable('x-powered-by');
  app.locals.dev = dev;
  // Template helpers: it.w.json(data), it.w.url(value), it.w.asset('/css/style.css'),
  // it.w.date(), number(), truncate(), classes(), active(), slug()
  app.locals.w = { json, url, asset: createAsset(publicDir, dev), ...createHelpers(config.locale) };
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  // Per-request context: id, logger, CSP nonce, safe cookie helper
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.log = log.child({ reqId: req.id });
    res.set('X-Request-Id', req.id);
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
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      req.log[quiet.has(req.path) ? 'debug' : 'info']({ status: res.statusCode, ms }, `${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  // Health checks (before rate limits so probes are never throttled)
  if (config.health) {
    const { path: healthPath, readyPath, checks = {} } = config.health;
    app.get(healthPath, (req, res) => res.json({ ok: true }));
    app.get(readyPath, async (req, res) => {
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

  mount(rateLimiters(config));
  mount(originCheck(config));
  mount(bodyParsers(config));

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

  // Stops accepting requests, runs ctx.onClose handlers, lets running requests finish, then exits.
  // Connections still open after config.shutdownTimeout are closed forcibly (exit code 1).
  let stopping = false;
  const shutdown = async (server) => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      log.warn('Shutdown timed out, closing open connections');
      server.closeAllConnections?.();
      process.exit(1);
    }, config.shutdownTimeout);
    timer.unref();

    const closed = new Promise((resolve) => server.close(resolve)); // resolves when every connection has ended
    server.closeIdleConnections?.();
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch (err) {
        log.error({ err }, 'Error while shutting down');
      }
    }
    server.closeIdleConnections?.();
    await closed;
    process.exit(0);
  };

  const start = () =>
    new Promise((resolve) => {
      const server = app.listen(config.port, () => {
        printBanner({ port: config.port, dev, routes: ctx.routes });
        resolve(server);
      });
      process.on('SIGTERM', () => shutdown(server));
      process.on('SIGINT', () => shutdown(server));
    });

  return { app, start, ctx };
}
