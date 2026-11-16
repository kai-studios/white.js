import { duration } from './duration.js';

// In-memory cache with expiry, a size limit (least recently used goes first) and
// de-duplication of concurrent work.
//
//   const cache = createCache({ ttl: '5m', max: 500 });
//   const posts = await cache.wrap('posts', () => db.posts(), '30s');
//
// wrap() runs the function once even when many requests ask at the same time, and
// does not cache a failure.
export function createCache({ ttl = '1m', max = 500 } = {}) {
  const defaultTtl = duration(ttl);
  const store = new Map(); // key -> { value, expires }
  const pending = new Map(); // key -> Promise

  const get = (key) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    // re-insert so the Map order is "least recently used first"
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  };

  const set = (key, value, ttlOverride) => {
    store.delete(key);
    store.set(key, { value, expires: Date.now() + (ttlOverride === undefined ? defaultTtl : duration(ttlOverride)) });
    while (store.size > max) store.delete(store.keys().next().value);
    return value;
  };

  const wrap = async (key, fn, ttlOverride) => {
    const hit = get(key);
    if (hit !== undefined) return hit;
    if (pending.has(key)) return pending.get(key);
    const run = Promise.resolve()
      .then(fn)
      .then((value) => set(key, value, ttlOverride))
      .finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
  };

  return {
    get,
    set,
    wrap,
    has: (key) => get(key) !== undefined,
    delete: (key) => store.delete(key),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}

// Route middleware that lets browsers and CDNs cache the response:
//   router.get('/', cacheControl('1h'), handler)
//   router.get('/me', cacheControl(0), handler)   // never cache
export function cacheControl(time, { visibility = 'public' } = {}) {
  const seconds = Math.floor(duration(time) / 1000);
  const value = seconds === 0 ? 'no-store' : `${visibility}, max-age=${seconds}`;
  return (req, res, next) => {
    res.set('Cache-Control', value);
    next();
  };
}
