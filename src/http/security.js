import helmet from 'helmet';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../core/errors.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Security headers. The CSP allows scripts carrying the per-request nonce:
// <script nonce="<%= it.nonce %>">
export function securityHeaders({ security }, dev) {
  if (!security.helmet) return [];
  const options = security.helmet === true ? {} : { ...security.helmet };

  if (security.csp === false) {
    options.contentSecurityPolicy = false;
  } else {
    const custom = security.csp === true ? {} : security.csp;
    const nonce = (req, res) => `'nonce-${res.locals.nonce}'`;
    options.contentSecurityPolicy = {
      useDefaults: true,
      directives: {
        // http://localhost must not be upgraded to https in development
        ...(dev ? { 'upgrade-insecure-requests': null } : {}),
        ...custom,
        'script-src': [...(custom['script-src'] ?? ["'self'"]), nonce],
      },
    };
  }
  return [helmet(options)];
}

// CSRF protection: state-changing requests must come from the same origin
// (or one listed in security.origin.allowed). Requests without an Origin
// header (curl, server-to-server) are not browser-driven and pass.
export function originCheck({ security }) {
  if (!security.origin) return [];
  const allowed = new Set(security.origin.allowed ?? []);
  const reject = (next) => next(new HttpError(403, 'Cross-origin request blocked'));

  return [
    (req, res, next) => {
      if (!UNSAFE_METHODS.has(req.method)) return next();
      const origin = req.get('origin');
      if (origin) {
        let host;
        try {
          host = new URL(origin).host;
        } catch {
          return reject(next);
        }
        return allowed.has(origin) || host === req.host ? next() : reject(next);
      }
      return req.get('sec-fetch-site') === 'cross-site' ? reject(next) : next();
    },
  ];
}

// Soft limit for the whole site and a stricter one for /api
export function rateLimiters({ security }) {
  const rl = security.rateLimit;
  if (!rl) return [];
  const make = (limit) =>
    rateLimit({
      windowMs: rl.windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res, next) => next(new HttpError(429, 'Too many requests')),
    });
  const list = [make(rl.limit)];
  if (rl.api) list.push(['/api', make(rl.api.limit ?? rl.limit)]);
  return list;
}

export function bodyParsers({ security }) {
  const limit = security.bodyLimit;
  return [express.json({ limit }), express.urlencoded({ extended: false, limit })];
}
