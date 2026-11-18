export function setWithinBudget<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  size: (value: V) => number,
  budget: number,
) {
  cache.delete(key);
  cache.set(key, value);
  let total = 0;
  for (const entry of cache.values()) total += size(entry);
  for (const [oldest, entry] of cache) {
    if (total <= budget || oldest === key) break;
    cache.delete(oldest);
    total -= size(entry);
  }
}
