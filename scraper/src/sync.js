// Decide what to write so Firestore mirrors the venue's current calendar,
// while keeping write counts low (Spark plan: 20k writes/day).

const COMPARE_FIELDS = ['title', 'end', 'allDay', 'description', 'url', 'image', 'location', 'price', 'category', 'venueName'];
const PURGE_AFTER_MS = 30 * 864e5;

const toMs = (v) => (v == null ? null : v instanceof Date ? v.getTime() : typeof v.toMillis === 'function' ? v.toMillis() : +new Date(v));

function same(a, b) {
  if (a instanceof Date || b instanceof Date || a?.toMillis || b?.toMillis) return toMs(a) === toMs(b);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
  return (a ?? '') === (b ?? '');
}

/**
 * @param {Map<string, object>} existing  id -> stored event data
 * @param {object[]} scraped               normalized events
 * @param {{now: Date, allowRemovals: boolean}} opts
 */
export function diffEvents(existing, scraped, { now, allowRemovals }) {
  const nowMs = now.getTime();
  const creates = [];
  const updates = [];
  const removes = [];
  const purges = [];
  const seen = new Set();

  for (const ev of scraped) {
    seen.add(ev.id);
    const prev = existing.get(ev.id);
    if (!prev) {
      creates.push(ev);
      continue;
    }
    const changed = {};
    for (const f of COMPARE_FIELDS) if (!same(prev[f], ev[f])) changed[f] = ev[f];
    if (!same(prev.tags, ev.tags)) changed.tags = ev.tags;
    if (prev.removed) {
      changed.removed = false;
      changed.removedAt = null;
    }
    if (Object.keys(changed).length) updates.push({ id: ev.id, changed });
  }

  for (const [id, prev] of existing) {
    if (seen.has(id)) continue;
    const endMs = toMs(prev.end) ?? toMs(prev.start);
    if (endMs < nowMs - PURGE_AFTER_MS) {
      purges.push(id);
    } else if (allowRemovals && !prev.removed && toMs(prev.start) > nowMs) {
      // Still in the future but no longer listed: the venue removed or moved it.
      removes.push(id);
    }
  }
  return { creates, updates, removes, purges };
}
