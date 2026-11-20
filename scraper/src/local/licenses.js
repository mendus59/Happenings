// Washington State Liquor and Cannabis Board "Local Authority Letters": notices sent to cities
// and counties when a business applies for a liquor license. A new restaurant, bar, brewery
// or winery almost always files one before opening. The feed only keeps recent notices, so
// it's read daily. Dataset: https://data.wa.gov/d/vgcw-qfjm
import { fetchJson } from '../net.js';

export const LCB_URLS = [
  'https://data.wa.gov/resource/vgcw-qfjm.json?$limit=5000',
  'https://data.wa.gov/api/v3/views/vgcw-qfjm/query.json?accessType=DOWNLOAD',
];

const OPENING_TYPES = /NEW LICENSE APPLICATION|CHANGE OF LOCATION|ASSUMPTION/i;
const FOOD_DRINK_PRIV = /RESTAURANT|TAVERN|SNACK BAR|BREW|WINERY|DISTILL|NIGHTCLUB|THEATER|SPORTS ENTERTAINMENT|CATERING|CIDER/i;

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\b(Llc|Inc|Co)\b/g, (m) => m.toUpperCase())
    .trim();
}

function rowsFrom(data) {
  if (Array.isArray(data)) return data;
  // SODA3 query.json: { data: [...] } or rows of objects
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function coords(row) {
  const loc = row.location || row.location_1;
  if (loc?.coordinates?.length === 2) return { lat: Number(loc.coordinates[1]), lon: Number(loc.coordinates[0]) };
  if (loc?.latitude && loc?.longitude) return { lat: Number(loc.latitude), lon: Number(loc.longitude) };
  if (typeof loc === 'string') {
    const m = loc.match(/POINT \(([-\d.]+) ([-\d.]+)\)/);
    if (m) return { lat: Number(m[2]), lon: Number(m[1]) };
  }
  return null;
}

/** Pure: turn raw LCB rows into opening candidates. */
export function openingsFromLcbRows(rows) {
  const out = [];
  for (const r of rows) {
    const privs = Object.keys(r)
      .filter((k) => /^privdesc\d+$/.test(k) && r[k])
      .map((k) => String(r[k]).trim());
    if (!OPENING_TYPES.test(r.l_a_type || '')) continue;
    if (!privs.some((p) => FOOD_DRINK_PRIV.test(p))) continue;
    const c = coords(r);
    if (!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
    const priv = privs.join(' · ');
    const kind = /BREW|WINERY|DISTILL|CIDER/i.test(priv) ? 'brewery' : /TAVERN|NIGHTCLUB|LOUNGE/i.test(priv) && !/RESTAURANT/i.test(priv) ? 'bar' : 'restaurant';
    const date = /^\d{8}$/.test(r.applicationdate || '')
      ? `${r.applicationdate.slice(0, 4)}-${r.applicationdate.slice(4, 6)}-${r.applicationdate.slice(6, 8)}`
      : (r.la_posted_date || '').slice(0, 10);
    const type = String(r.l_a_type).toUpperCase();
    out.push({
      id: `lcb_${r.license}_${(date || '').replace(/-/g, '')}`,
      change: 'opening',
      source: 'license',
      name: titleCase(r.tradename || r.licenseename),
      kind,
      lat: c.lat,
      lon: c.lon,
      address: titleCase([r.streetaddress, r.city].filter(Boolean).join(', ')),
      detail: `${/CHANGE OF LOCATION/.test(type) ? 'Moving to a new location' : /ASSUMPTION/.test(type) ? 'New owner taking over' : 'Applied for a new liquor license'}: ${titleCase(priv)}`,
      date,
      website: '',
    });
  }
  return out;
}

export async function fetchLcbOpenings(log = console.log) {
  for (const url of LCB_URLS) {
    try {
      const rows = rowsFrom(await fetchJson(url, { timeoutMs: 60000 }));
      if (rows.length) {
        log(`LCB notices: ${rows.length} rows from ${new URL(url).pathname}`);
        return openingsFromLcbRows(rows);
      }
    } catch (e) {
      log(`LCB fetch failed (${url}): ${e.message}`);
    }
  }
  return [];
}
