import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from '../core/errors.js';
import { version } from '../core/meta.js';
import { duration } from '../utils/duration.js';
import { createBreaker } from './breaker.js';
import { requestContext } from './context.js';
import { signRequest } from './sign.js';

// A call to another service failed: it did not answer, timed out, or the circuit is open.
// It is an HttpError, so a route that does not catch it answers 502, 503 or 504.
export class UpstreamError extends HttpError {
  constructor(peer, message, { status = 502, cause, upstreamStatus, response } = {}) {
    super(status, message);
    this.peer = peer;
    if (cause) this.cause = cause;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
    if (response) this.response = response;
  }
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);

// "/api/x" + base "http://host/prefix" -> { href, target: "/prefix/api/x?q=1" }
function buildTarget(base, path, query) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError(`Path must be relative and start with a single "/": ${JSON.stringify(path)}`);
  }
  const url = new URL(base.origin + base.pathname.replace(/\/$/, '') + path);
  if (url.origin !== base.origin) throw new TypeError(`Path leaves the peer: ${JSON.stringify(path)}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of [].concat(value)) if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
  }
  url.hash = '';
  return { href: url.href, target: url.pathname + url.search };
}

// Reads a response body, giving up when it is larger than `max` bytes
async function readBody(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// An HTTP client for one other service. Signs every request, carries the current request id,
// retries what is safe to retry, and stops calling a service that keeps failing.
//
//   const billing = createClient({ name: 'billing', from: 'web', url: 'http://billing:3000', secret });
//   const res = await billing.get('/api/internal/invoices', { query: { page: 2 } });
//   const created = await billing.json('POST', '/api/internal/invoices', { json: { amount: 10 } });
//
// Redirects are never followed (the signature must not travel to another address).
// Network errors, timeouts and 5xx answers count against the circuit breaker; 4xx do not.
// GET, HEAD, PUT, DELETE and OPTIONS are retried on network errors and 408/429/502/503/504;
// other methods only with `{ idempotent: true }` (use it when the receiver de-duplicates).
// `{ retryStatus: [500] }` adds more statuses to retry on for one call.
export function createClient({
  name,
  url,
  from,
  secret,
  timeout = '5s',
  retries = 2,
  retryDelay = '100ms',
  maxDelay = '2s',
  maxResponse = 5 * 1024 * 1024,
  breaker,
  log,
  signal: lifetime,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!name) throw new TypeError('createClient: "name" is required');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError(`createClient: "${name}" url must be http(s)`);
  const defaultTimeout = duration(timeout);
  const baseDelay = duration(retryDelay);
  const capDelay = duration(maxDelay);
  const circuit = breaker === false ? null : createBreaker(breaker ?? {});

  const delayFor = (attempt, res) => {
    const retryAfter = res ? Number(res.headers.get('retry-after')) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5000);
    return Math.random() * Math.min(capDelay, baseDelay * 2 ** (attempt - 1)); // full jitter
  };

  // One attempt. Returns a response object or throws.
  async function once(method, path, opts, bytes, contentType, attempt) {
    const { href, target } = buildTarget(base, path, opts.query);
    const headers = { accept: 'application/json', 'user-agent': `white-js/${version}` };
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      const lower = key.toLowerCase();
      if (!lower.startsWith('x-white-') && lower !== 'host') headers[lower] = value;
    }
    if (contentType && !headers['content-type']) headers['content-type'] = contentType;
    const requestId = requestContext.getStore()?.id;
    if (requestId && !headers['x-request-id']) headers['x-request-id'] = requestId;
    // A fresh signature (new nonce) for every attempt: the receiver may have seen the last one
    if (secret && from) Object.assign(headers, signRequest(secret, { method, target, body: bytes, from, to: name }));

    const signals = [AbortSignal.timeout(opts.timeout === undefined ? defaultTimeout : duration(opts.timeout))];
    if (opts.signal) signals.push(opts.signal);
    if (lifetime) signals.push(lifetime);

    const started = performance.now();
    const res = await fetchImpl(href, { method, headers, body: bytes, redirect: 'manual', signal: AbortSignal.any(signals) });
    const raw = await readBody(res, opts.maxResponse ?? maxResponse);
    if (raw === null) throw new UpstreamError(name, `Upstream "${name}" sent a response that is too large`, { status: 502 });

    const text = raw.toString('utf8');
    let json;
    if ((res.headers.get('content-type') ?? '').includes('json') && text) {
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON after all: `text` is still there
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json, peer: name, attempts: attempt, ms: Math.round(performance.now() - started) };
  }

  async function request(method, path, opts = {}) {
    method = method.toUpperCase();
    let bytes;
    let contentType;
    if (opts.json !== undefined) {
      bytes = Buffer.from(JSON.stringify(opts.json));
      contentType = 'application/json';
    } else if (opts.form) {
      bytes = Buffer.from(new URLSearchParams(opts.form).toString());
      contentType = 'application/x-www-form-urlencoded';
    } else if (opts.body !== undefined) {
      bytes = Buffer.from(opts.body);
    }

    const idempotent = IDEMPOTENT.has(method) || opts.idempotent === true;
    const attempts = idempotent ? 1 + (opts.retries ?? retries) : 1;
    const useCircuit = circuit && opts.breaker !== false;

    for (let attempt = 1; ; attempt++) {
      if (useCircuit && !circuit.allow()) {
        throw new UpstreamError(name, `Upstream "${name}" is unavailable (circuit open)`, { status: 503 });
      }
      let res;
      try {
        res = await once(method, path, opts, bytes, contentType, attempt);
      } catch (err) {
        if (err instanceof TypeError && /Path |url must/.test(err.message)) {
          useCircuit && circuit.cancel();
          throw err; // a bug in the caller, not a failure of the service
        }
        if (opts.signal?.aborted) {
          useCircuit && circuit.cancel();
          throw err; // the caller gave up
        }
        if (lifetime?.aborted) {
          useCircuit && circuit.cancel();
          throw new UpstreamError(name, 'Shutting down', { status: 503, cause: err });
        }
        useCircuit && circuit.failure();
        if (attempt < attempts) {
          log?.debug({ peer: name, attempt, err: err.message }, `Call to ${name} failed, retrying`);
          await sleep(delayFor(attempt), undefined, { signal: opts.signal });
          continue;
        }
        if (err instanceof UpstreamError) throw err;
        const timedOut = err?.name === 'TimeoutError';
        throw new UpstreamError(name, timedOut ? `Upstream "${name}" timed out` : `Upstream "${name}" is unreachable`, {
          status: timedOut ? 504 : 502,
          cause: err,
        });
      }

      if (useCircuit) res.status >= 500 ? circuit.failure() : circuit.success();
      if ((RETRY_STATUS.has(res.status) || opts.retryStatus?.includes(res.status)) && attempt < attempts) {
        log?.debug({ peer: name, attempt, status: res.status }, `Call to ${name} answered ${res.status}, retrying`);
        const headers = res.headers;
        await sleep(delayFor(attempt, { headers }), undefined, { signal: opts.signal });
        continue;
      }
      return res;
    }
  }

  // Parsed JSON body, or an UpstreamError when the service did not answer 2xx
  async function json(method, path, opts) {
    const res = await request(method, path, opts);
    if (!res.ok) {
      throw new UpstreamError(name, `Upstream "${name}" answered ${res.status}`, { status: 502, upstreamStatus: res.status, response: res });
    }
    return res.json;
  }

  return {
    name,
    url: base.href,
    request,
    json,
    get: (path, opts) => request('GET', path, opts),
    head: (path, opts) => request('HEAD', path, opts),
    post: (path, opts) => request('POST', path, opts),
    put: (path, opts) => request('PUT', path, opts),
    patch: (path, opts) => request('PATCH', path, opts),
    delete: (path, opts) => request('DELETE', path, opts),
    breaker: circuit,
  };
}
