// One-off diagnostic (not merged): is Moonbeem's on the map / in the license feeds?
import { fetchOverpass } from '../shared/places.js';
const UA = { 'user-agent': 'Happenings/1.0 (+https://github.com/mendus59/Happenings)', accept: 'application/json' };
const box = '(47.49,-122.66,47.56,-122.58)';
const q = `[out:json][timeout:60];(nwr["name"~"moon",i]${box};nwr["addr:housenumber"="1386"]["addr:street"~"Lund",i]${box};nwr["amenity"](around:120,47.5203,-122.6146););out center tags;`;
try {
  const j = await fetchOverpass(q, { headers: UA, timeoutMs: 90000, rounds: 2 });
  for (const e of j.elements || []) console.log('OSM', e.type, e.id, e.lat ?? e.center?.lat, e.lon ?? e.center?.lon, JSON.stringify(e.tags));
  console.log('OSM total', (j.elements || []).length);
} catch (e) { console.log('OSM failed', e.message); }
const sets = { letters: 'vgcw-qfjm' };
for (const [name, id] of Object.entries(sets)) {
  const r = await fetch(`https://data.wa.gov/resource/${id}.json?$limit=50000`).then((x) => x.json()).catch((e) => ({ error: e.message }));
  const rows = Array.isArray(r) ? r : [];
  console.log(name, 'rows', rows.length, r.error || '');
  const dates = rows.map((x) => x.applicationdate || x.la_posted_date || '').filter(Boolean).sort();
  console.log(name, 'date range', dates[0], dates.at(-1));
  for (const x of rows) if (/moon|lund/i.test(JSON.stringify(x))) console.log(name, 'MATCH', JSON.stringify(x));
  for (const x of rows) if (/PORT ORCHARD/i.test(JSON.stringify(x))) console.log(name, 'PO', x.tradename, x.streetaddress, x.l_a_type, x.applicationdate || x.la_posted_date);
}
// Look for other LCB datasets on data.wa.gov
const cat = await fetch('https://data.wa.gov/api/catalog/v1?q=liquor%20license&limit=40').then((x) => x.json()).catch((e) => ({ error: e.message }));
for (const d of cat.results || []) console.log('DATASET', d.resource.id, d.resource.name, d.resource.updatedAt);
