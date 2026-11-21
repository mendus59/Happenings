// Street addresses -> coordinates with the free US Census Bureau batch geocoder
// (https://geocoding.geo.census.gov, up to 10,000 addresses per request, no key).
// Results are cached in a few Firestore documents (geocache/lcb_N) so each address is
// looked up once; misses are retried after a month.

const BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH = 2000;
const PER_DOC = 4000;
const MISS_RETRY_DAYS = 30;

export const addressKey = (a) => [a.street, a.city, a.zip].map((s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()).join('|');

const csvField = (s) => `"${String(s || '').replace(/"/g, '')}"`;

/** Pure: parse the geocoder's CSV answer into { id: {lat, lon} | null }. */
export function parseBatch(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const [id, , match, , , coords] = cells;
    if (!id) continue;
    if (/^match$/i.test(match) && coords) {
      const [lon, lat] = coords.split(',').map(Number);
      out[id] = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) } : null;
    } else out[id] = null;
  }
  return out;
}

async function geocodeBatch(addresses, log) {
  const csv = addresses.map((a, i) => [i, a.street, a.city, a.state || 'WA', a.zip].map(csvField).join(',')).join('\n');
  const form = new FormData();
  form.append('benchmark', 'Public_AR_Current');
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  const res = await fetch(BATCH_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(15 * 60e3) });
  if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
  const parsed = parseBatch(await res.text());
  log?.(`  geocoded ${addresses.length} addresses, ${Object.values(parsed).filter(Boolean).length} found`);
  return addresses.map((_, i) => parsed[i] ?? null);
}

/**
 * Look up coordinates for addresses ({street, city, state, zip}), using and filling the cache.
 * Returns a Map addressKey -> {lat, lon} (missing when not found).
 */
export async function geocodeAll(db, addresses, { log = console.log, now = Date.now() } = {}) {
  // db = null: no cache (dry runs).
  const docs = db ? (await db.collection('geocache').get()).docs.filter((d) => d.id.startsWith('lcb_')) : [];
  const cache = {};
  for (const d of docs) Object.assign(cache, d.get('m') || {});
  const want = new Map();
  for (const a of addresses) {
    const k = addressKey(a);
    const c = cache[k];
    const stale = !c || (c.length === 1 && now - c[0] > MISS_RETRY_DAYS * 864e5);
    if (stale && a.street && a.city) want.set(k, a);
  }
  log(`Geocode: ${addresses.length} addresses, ${want.size} not cached`);
  const todo = [...want.entries()];
  let changed = false;
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    try {
      const res = await geocodeBatch(part.map(([, a]) => a), log);
      part.forEach(([k], j) => {
        // [lat, lon] when found, [checkedAt] when not.
        cache[k] = res[j] ? [res[j].lat, res[j].lon] : [now];
      });
      changed = true;
    } catch (e) {
      log(`  geocoder failed: ${e.message}`);
      break;
    }
  }
  if (changed && db) {
    const entries = Object.entries(cache);
    const batch = db.batch();
    const n = Math.ceil(entries.length / PER_DOC);
    for (let i = 0; i < n; i++) batch.set(db.doc(`geocache/lcb_${i}`), { m: Object.fromEntries(entries.slice(i * PER_DOC, (i + 1) * PER_DOC)) });
    for (const d of docs) if (Number(d.id.slice(4)) >= n) batch.delete(d.ref);
    await batch.commit();
  }
  const out = new Map();
  for (const a of addresses) {
    const c = cache[addressKey(a)];
    if (c?.length === 2) out.set(addressKey(a), { lat: c[0], lon: c[1] });
  }
  return out;
}
