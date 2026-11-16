// In-memory "have I seen this?" store with expiry. claim() is atomic: of two identical
// concurrent calls exactly one gets `true`.
//
// With several instances of one service behind a balancer, give each service an object with
// the same shape backed by a shared store (for Redis: SET key 1 NX PX ttl) via `mesh.nonces`.
export function createNonceStore({ max = 50_000, now = Date.now } = {}) {
  const store = new Map(); // key -> expires (insertion order is expiry order for one ttl)

  const purge = () => {
    const t = now();
    for (const [key, expires] of store) {
      if (expires > t) break;
      store.delete(key);
    }
  };

  return {
    claim(key, ttl) {
      purge();
      const t = now();
      const expires = store.get(key);
      if (expires !== undefined && expires > t) return false;
      store.delete(key);
      store.set(key, t + ttl);
      while (store.size > max) store.delete(store.keys().next().value);
      return true;
    },
    release: (key) => store.delete(key),
    get size() {
      purge();
      return store.size;
    },
  };
}
