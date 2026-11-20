// Monthly OpenStreetMap comparison: places newly mapped (likely openings) and places that
// vanished or got tagged as disused (likely closings), within each user area.
import { overpassQuery, placeFromElement, OVERPASS_URL, FOOD_DRINK_KINDS } from '../../../shared/places.js';
import { UA } from '../net.js';

export async function fetchOsmPlaces(area) {
  const body = new URLSearchParams({ data: overpassQuery({ bbox: [area.s, area.w, area.n, area.e], onlyFoodDrink: true, timeout: 90 }) });
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body,
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  return (json.elements || []).map(placeFromElement).filter((p) => p && FOOD_DRINK_KINDS.has(p.kind));
}

/**
 * Pure: compare last month's snapshot with today's places.
 * prev/current: { [id]: {name, kind, lat, lon, website, address, closed} }
 */
export function diffOsm(prev, current, today) {
  const changes = [];
  if (!prev) return changes; // first look at an area: nothing to compare yet
  for (const [id, p] of Object.entries(current)) {
    const before = prev[id];
    if (!before && !p.closed) {
      changes.push({ id: `osm_open_${id}`, change: 'opening', source: 'map', detail: 'Newly added to OpenStreetMap', date: today, ...pick(p) });
    } else if (before && !before.closed && p.closed) {
      changes.push({ id: `osm_closed_${id}`, change: 'closing', source: 'map', detail: 'Marked closed on OpenStreetMap', date: today, ...pick(p) });
    }
  }
  for (const [id, p] of Object.entries(prev)) {
    if (!current[id] && !p.closed) {
      changes.push({ id: `osm_gone_${id}`, change: 'closing', source: 'map', detail: 'Removed from OpenStreetMap (may have closed)', date: today, ...pick(p) });
    }
  }
  return changes;
}

const pick = (p) => ({ name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, website: p.website || '', address: p.address || '' });

export function snapshotOf(places) {
  const out = {};
  for (const p of places) out[p.id.replace('/', '_')] = { ...pick(p), closed: !!p.closed };
  return out;
}
