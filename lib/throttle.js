// A small limit on how often something can be tried, kept in memory. Each server
// instance counts for itself, which is enough to make guessing slow.

const hits = new Map();
const CLEAN_AT = 5000;

// False once `key` has been used `max` times within the last `windowMs`
function allow(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > CLEAN_AT) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
  return true;
}
const clear = key => hits.delete(key);

module.exports = { allow, clear };
