// Location helpers shared by the web app and the scheduled jobs.
// A user's home area is a rectangle they draw on the map ("box": {s, w, n, e} in degrees),
// so it can follow real travel time (water, mountains) instead of a straight-line radius.

/** Largest box we allow (about 110 km tall, 110 km wide at 47° N). Keeps map queries polite. */
export const MAX_BOX = { lat: 1.0, lon: 1.5 };
export const MIN_BOX = 0.02;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Clean up a drawn box: order the edges, round outward to 0.01° (about 1 km, so no exact
 * address is ever stored), and shrink it to MAX_BOX around its center if it's too big.
 * Returns null for anything unusable.
 */
export function normalizeBox(b) {
  if (!b) return null;
  let s = Math.min(b.s, b.n);
  let n = Math.max(b.s, b.n);
  let w = Math.min(b.w, b.e);
  let e = Math.max(b.w, b.e);
  if (![s, w, n, e].every(Number.isFinite)) return null;
  if (n - s > MAX_BOX.lat) {
    const c = (s + n) / 2;
    s = c - MAX_BOX.lat / 2;
    n = c + MAX_BOX.lat / 2;
  }
  if (e - w > MAX_BOX.lon) {
    const c = (w + e) / 2;
    w = c - MAX_BOX.lon / 2;
    e = c + MAX_BOX.lon / 2;
  }
  const r = (x) => Number(x.toFixed(2));
  const out = {
    s: r(clamp(Math.floor(s * 100 + 1e-9) / 100, -90, 90)),
    w: r(clamp(Math.floor(w * 100 + 1e-9) / 100, -180, 180)),
    n: r(clamp(Math.ceil(n * 100 - 1e-9) / 100, -90, 90)),
    e: r(clamp(Math.ceil(e * 100 - 1e-9) / 100, -180, 180)),
  };
  // Rounding outward can add 0.01° on each side; trim back inside the limit.
  if (out.n - out.s > MAX_BOX.lat + 1e-9) out.n = r(out.s + MAX_BOX.lat);
  if (out.e - out.w > MAX_BOX.lon + 1e-9) out.e = r(out.w + MAX_BOX.lon);
  if (out.n - out.s < MIN_BOX || out.e - out.w < MIN_BOX) return null;
  return out;
}

/** The box stored on a profile doc, or null. */
export function profileBox(p) {
  if (!p || ![p.boxS, p.boxW, p.boxN, p.boxE].every((x) => typeof x === 'number')) return null;
  return { s: p.boxS, w: p.boxW, n: p.boxN, e: p.boxE };
}

/** A default starting box around a point: about 15 km in each direction. */
export function boxAround(lat, lon, km = 15) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

export const boxCenter = (b) => ({ lat: (b.s + b.n) / 2, lon: (b.w + b.e) / 2 });

export const inBox = (b, p) => p && p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e;

/** Rough size, for showing the user ("about 30 × 25 km"). */
export function boxSizeKm(b) {
  const c = boxCenter(b);
  return {
    tall: distanceKm({ lat: b.s, lon: c.lon }, { lat: b.n, lon: c.lon }),
    wide: distanceKm({ lat: c.lat, lon: b.w }, { lat: c.lat, lon: b.e }),
  };
}

/**
 * Users with similar boxes share one "area", so the scheduled job does the work once.
 * Edges snap outward to a 0.05° grid (~5 km), so the area always covers the user's box.
 */
export function areaFor(box) {
  const b = normalizeBox(box);
  if (!b) return null;
  const step = 0.05;
  const down = (x) => Number((Math.floor(x / step + 1e-9) * step).toFixed(2));
  const up = (x) => Number((Math.ceil(x / step - 1e-9) * step).toFixed(2));
  const a = { s: down(b.s), w: down(b.w), n: up(b.n), e: up(b.e) };
  const id = `a_${[a.s, a.w, a.n, a.e].map((x) => x.toFixed(2)).join('_')}`.replace(/-/g, 'm').replace(/\./g, 'p');
  return { id, ...a };
}

/** Bare host of a URL, without "www.", for matching websites. */
export function siteKey(url) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
