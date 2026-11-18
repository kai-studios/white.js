import { HttpError, UnauthorizedError, ForbiddenError } from '../core/errors.js';
import { verifyRequest, SignatureError, HEADERS } from './sign.js';

const FAIL_LIMIT = 30; // failed attempts per address and window
const FAIL_WINDOW = 60_000;

// Builds the `auth(options)` middleware factory of a service.
//
//   router.get('/', mesh.auth(), handler)                  any known service
//   router.get('/', mesh.auth({ allow: ['admin'] }), ...)  only these services
//
// On success `req.service = { name }`. Everything else gets one generic 401, so the answer
// does not tell an attacker whether a name, a time or a signature was wrong (the reason is
// logged). Too many failures from one address are answered with 429 before any checking.
export function createAuth({ name, secretFor, skew, nonces, now = Date.now }) {
  const failures = new Map(); // ip -> { count, reset }

  const blocked = (ip) => {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (entry.reset <= now()) return failures.delete(ip), false;
    return entry.count >= FAIL_LIMIT;
  };
  const record = (ip) => {
    const t = now();
    let entry = failures.get(ip);
    if (!entry || entry.reset <= t) failures.set(ip, (entry = { count: 0, reset: t + FAIL_WINDOW }));
    entry.count += 1;
    if (failures.size > 10_000) failures.delete(failures.keys().next().value);
  };

  return (options = {}) => {
    const allow = options.allow ? new Set([].concat(options.allow)) : null;
    return async (req, res, next) => {
      try {
        // Already authenticated by an earlier layer (a `protect` prefix): only check the allow list
        if (req.service) {
          if (allow && !allow.has(req.service.name)) throw new ForbiddenError('This service may not use this route');
          return next();
        }
        if (blocked(req.ip)) throw new HttpError(429, 'Too many failed attempts');
        let result;
        try {
          result = await verifyRequest({
            header: (h) => req.get(h),
            method: req.method,
            target: req.originalUrl,
            body: req.rawBody,
            to: name,
            secretFor,
            skew,
            nonces,
          });
        } catch (err) {
          if (!(err instanceof SignatureError)) throw err;
          record(req.ip);
          req.log?.warn({ reason: err.reason, from: req.get(HEADERS.service) }, 'Service authentication failed');
          throw new UnauthorizedError('Invalid service credentials');
        }
        if (allow && !allow.has(result.from)) throw new ForbiddenError('This service may not use this route');
        req.service = { name: result.from };
        req.app.locals.adoptRequestId?.(req, res); // the caller is known: its request id continues the trace
        next();
      } catch (err) {
        next(err);
      }
    };
  };
}
