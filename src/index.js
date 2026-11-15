import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutes, loadPlugins } from './loader.js';
import { etaEngine } from './views.js';
import { printBanner } from './banner.js';
import { errorPage } from './pages.js';
import { createLogger } from './logger.js';
import { securityHeaders, originCheck, rateLimiters, bodyParsers } from './security.js';
import { json, url, createAsset } from './helpers.js';

export { loadConfig, resolveConfig, ConfigError } from './config.js';
export { validate } from './validate.js';
export * from './errors.js';

export async function createApp(config, root = process.cwd()) {
  const dev = process.env.NODE_ENV !== 'production';
  const abs = (p) => path.resolve(root, p);
  const log = createLogger(config, dev);
  const ctx = { config, root, dev, abs, log, routes: [] };

  const viewsDir = abs(config.dirs.views);
  const publicDir = abs(config.dirs.public);
  const hasErrorView = fs.existsSync(path.join(viewsDir, 'error.eta'));

  const app = express();
  app.disable('x-powered-by');
  app.locals.dev = dev;
  // Template helpers: it.w.json(data), it.w.url(value), it.w.asset('/css/style.css')
  app.locals.w = { json, url, asset: createAsset(publicDir, dev) };
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  // Per-request context: id, logger, CSP nonce, safe cookie helper
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.log = log.child({ reqId: req.id });
    res.set('X-Request-Id', req.id);
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    res.secureCookie = (name, value, options = {}) =>
      res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: !dev, path: '/', ...options });
    next();
  });

  // Mounts a list of middleware (or [path, middleware] pairs); an empty list mounts nothing
  const mount = (list) => list.forEach((entry) => app.use(...[].concat(entry)));

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

  const start = () =>
    new Promise((resolve) => {
      const server = app.listen(config.port, () => {
        printBanner({ port: config.port, dev, routes: ctx.routes });
        resolve(server);
      });
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    });

  return { app, start, ctx };
}
