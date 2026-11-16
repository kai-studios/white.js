import crypto from 'node:crypto';

// Request signing between services (HMAC-SHA256).
//
// A signature covers the timestamp, a one-time nonce, the method, the path with its query
// string, a hash of the body, the caller and the receiver, so none of them can be changed,
// and a request meant for one service cannot be replayed against another. The secret itself
// is never sent. The body is not encrypted: use https between servers you do not control.

export const HEADERS = Object.freeze({
  service: 'x-white-service',
  timestamp: 'x-white-timestamp',
  nonce: 'x-white-nonce',
  signature: 'x-white-signature',
});

export const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;

// Why a signature was refused. `reason` is for logs only; callers see one generic message.
export class SignatureError extends Error {
  constructor(reason) {
    super(`Invalid signature (${reason})`);
    this.name = 'SignatureError';
    this.reason = reason;
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function canonicalString({ timestamp, nonce, method, target, body, from, to }) {
  return ['WHITE1', timestamp, nonce, String(method).toUpperCase(), target, sha256(body ?? ''), from, to].join('\n');
}

const mac = (secret, parts) => crypto.createHmac('sha256', secret).update(canonicalString(parts)).digest('hex');

// Returns the headers to add to an outgoing request.
// `target` is the path plus query exactly as sent ("/api/x?a=1"), `body` the exact bytes.
export function signRequest(secret, { method, target, body, from, to, now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = crypto.randomBytes(16).toString('base64url');
  return {
    [HEADERS.service]: from,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: mac(secret, { timestamp, nonce, method, target, body, from, to }),
  };
}

// Checks an incoming request and returns { from }. Throws SignatureError.
//   header(name)      reads a request header
//   secretFor(name)   the secret shared with that caller, or undefined if it is not allowed
//   nonces            { claim(key, ttlMs) -> boolean }: rejects a nonce that was already used
export async function verifyRequest({ header, method, target, body, to, secretFor, skew, nonces, now = Date.now() }) {
  const from = header(HEADERS.service);
  const timestamp = header(HEADERS.timestamp);
  const nonce = header(HEADERS.nonce);
  const signature = header(HEADERS.signature);

  if (!from || !timestamp || !nonce || !signature) throw new SignatureError('missing headers');
  if (!SERVICE_NAME.test(from)) throw new SignatureError('bad service name');
  if (!/^\d{1,12}$/.test(timestamp)) throw new SignatureError('bad timestamp');
  if (!NONCE.test(nonce)) throw new SignatureError('bad nonce');
  if (!HEX_SIGNATURE.test(signature)) throw new SignatureError('bad signature format');

  const secret = secretFor(from);
  if (!secret) throw new SignatureError('unknown service');
  if (Math.abs(now - Number(timestamp) * 1000) > skew) throw new SignatureError('timestamp outside the allowed window');

  const expected = Buffer.from(mac(secret, { timestamp, nonce, method, target, body, from, to }), 'hex');
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new SignatureError('signature mismatch');

  // Only a valid signature gets here, so strangers cannot fill the nonce store
  if (!(await nonces.claim(`${from}:${nonce}`, skew * 2))) throw new SignatureError('replayed request');
  return { from };
}
