/**
 * In-memory TTL cache for admin reads.
 *
 * Every admin request is a Netlify function hop plus an Apps Script execution,
 * which measured at 2-4s. Switching tabs re-ran those calls from scratch, so a
 * short cache turns tab switching from a multi-second wait into an instant
 * render while staying fresh enough that admins do not act on stale data.
 *
 * Deliberately in-memory, not sessionStorage: this data includes participant
 * emails and response content, and it should not outlive the tab.
 */
const store = new Map();
const inflight = new Map();

export const CACHE_TTL = {
  short: 15_000, // volatile: queue state, responses
  medium: 60_000, // activities, questions
};

const now = () => Date.now();

/**
 * Returns cached data when fresh, otherwise calls `loader`.
 * Concurrent callers for the same key share one request rather than
 * each firing their own.
 */
export async function cached(key, loader, ttl = CACHE_TTL.short) {
  const hit = store.get(key);
  if (hit && hit.expires > now()) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(loader)
    .then((value) => {
      store.set(key, { value, expires: now() + ttl });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

/** Read a fresh value and replace whatever is cached under `key`. */
export async function refresh(key, loader, ttl = CACHE_TTL.short) {
  invalidate(key);
  return cached(key, loader, ttl);
}

/**
 * Drop cache entries. A bare prefix clears every key beneath it, so a write
 * can invalidate a whole family ("responses:") without knowing each filter
 * combination that was cached.
 */
export function invalidate(prefix = "") {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()])
    if (key === prefix || key.startsWith(prefix)) store.delete(key);
}

/** Replace a cached value without a round trip — used by optimistic updates. */
export function patch(key, updater, ttl = CACHE_TTL.short) {
  const hit = store.get(key);
  if (!hit) return;
  store.set(key, { value: updater(hit.value), expires: now() + ttl });
}

/** Stable cache key from an action plus its filter object. */
export function keyFor(action, params = {}) {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k] ?? ""}`)
    .join("&");
  return parts ? `${action}:${parts}` : `${action}:`;
}
