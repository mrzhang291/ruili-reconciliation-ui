type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
let cacheVersion = 0;

export function cacheKey(scope: string, params?: unknown) {
  return params === undefined ? scope : `${scope}:${stableStringify(params)}`;
}

export async function readThroughCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const version = cacheVersion;
  const request = loader().then((value) => {
    if (cacheVersion === version) {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    return value;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

export function invalidateReadCache(prefixes?: string | string[]) {
  cacheVersion += 1;
  if (!prefixes) {
    cache.clear();
    return;
  }

  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  for (const key of cache.keys()) {
    if (list.some((prefix) => key.startsWith(prefix))) cache.delete(key);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
