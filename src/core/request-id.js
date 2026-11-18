import crypto from 'node:crypto';
import { ConfigError } from './white-error.js';
import { fromTrustedProxy } from './proxy.js';
import { requestContext } from '../mesh/context.js';

// Request ids tie together the log lines of one user action, across HTTP requests and calls
// between services. Who may choose the id is therefore a security decision:
//
//   accept: 'trusted' (default)  an incoming id is used only when the connection comes from a
//                                trusted proxy (see trustProxy); signed calls from known services
//                                are always accepted, because they are authenticated
//           'never'              always generate our own
//           'always'             believe any well-formed id from anyone (the old behaviour)
//
// Whatever the source, an id that does not match `pattern` is replaced by a generated one.
export const requestIdDefaults = {
  header: 'x-request-id',
  accept: 'trusted',
  pattern: /^[\w.-]{8,64}$/,
  generate: () => crypto.randomUUID(),
};

export function normalizeRequestId(raw = {}) {
  const options = { ...requestIdDefaults, ...raw };
  const problems = [];
  if (typeof options.header !== 'string' || !/^[a-z0-9-]+$/i.test(options.header)) problems.push('header must be an HTTP header name');
  if (!['trusted', 'never', 'always'].includes(options.accept)) problems.push('accept must be "trusted", "never" or "always"');
  if (!(options.pattern instanceof RegExp)) problems.push('pattern must be a RegExp');
  if (typeof options.generate !== 'function') problems.push('generate must be a function');
  if (problems.length) throw new ConfigError(`Invalid requestId:\n  - ${problems.join('\n  - ')}`);
  options.header = options.header.toLowerCase();
  return options;
}

export function createRequestId(rawOptions, { log, app }) {
  const options = normalizeRequestId(rawOptions);
  const valid = (id) => typeof id === 'string' && id.length <= 128 && options.pattern.test(id);

  function assign(req, res, id, source) {
    req.id = id;
    req.requestIdSource = source;
    req.log = log.child({ reqId: id });
    res.set(options.header, id);
    const store = requestContext.getStore();
    if (store) store.id = id; // calls to other services made from now on carry the new id
  }

  // Used by the first middleware of every request
  const middleware = (req, res, next) => {
    const incoming = req.get(options.header);
    if (incoming && options.accept !== 'never' && valid(incoming) && (options.accept === 'always' || fromTrustedProxy(req))) {
      assign(req, res, incoming, 'proxy');
    } else {
      let id = options.generate(req);
      if (!valid(id)) {
        log.warn('requestId.generate returned an id that does not match requestId.pattern; using a UUID');
        id = crypto.randomUUID();
      }
      assign(req, res, id, 'generated');
    }
    next();
  };

  // Called after a signed service call was verified: the caller is a known service, so the id
  // it forwards continues the same trace (the id is not part of the signature, hence the pattern check).
  app.locals.adoptRequestId = (req, res) => {
    const incoming = req.get(options.header);
    if (options.accept !== 'never' && valid(incoming) && incoming !== req.id) assign(req, res, incoming, 'service');
  };

  return middleware;
}
