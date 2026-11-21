// Location helpers shared by the web app and the scheduled jobs.
// A user's home area is a shape they draw on the map, so it can follow real travel time
// (water, mountains) instead of a straight-line radius. A "box" is {s, w, n, e} in degrees,
// the shape's bounding box, plus optional pts: [[lat, lon], ...] for the shape's corners.
// Jobs only use the bounding box; the app also checks the shape.

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
  if (Array.isArray(b.pts) && b.pts.length >= 3) return normalizeShape(b.pts);
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

export const MAX_POINTS = 16;

/**
 * Clean up a drawn shape: round corners to 0.01°, drop repeats, keep at most MAX_POINTS,
 * shrink it toward its middle if its bounding box is bigger than MAX_BOX.
 * Returns a box with pts, a plain box when the shape is just its own bounding rectangle,
 * or null when unusable.
 */
export function normalizeShape(points) {
  let pts = (points || []).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => p.every(Number.isFinite));
  if (pts.length < 3) return null;
  const bb = (list) => ({
    s: Math.min(...list.map((p) => p[0])), n: Math.max(...list.map((p) => p[0])),
    w: Math.min(...list.map((p) => p[1])), e: Math.max(...list.map((p) => p[1])),
  });
  let b = bb(pts);
  const k = Math.min(1, MAX_BOX.lat / (b.n - b.s || 1), MAX_BOX.lon / (b.e - b.w || 1));
  if (k < 1) {
    const c = [(b.s + b.n) / 2, (b.w + b.e) / 2];
    pts = pts.map((p) => [c[0] + (p[0] - c[0]) * k * 0.995, c[1] + (p[1] - c[1]) * k * 0.995]);
  }
  const r = (x) => Number(x.toFixed(2));
  pts = pts.map((p) => [r(clamp(p[0], -90, 90)), r(clamp(p[1], -180, 180))]);
  pts = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return p[0] !== q[0] || p[1] !== q[1];
  });
  if (pts.length > MAX_POINTS) pts = pts.slice(0, MAX_POINTS);
  if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1e-6) return null;
  b = bb(pts);
  if (b.n - b.s < MIN_BOX || b.e - b.w < MIN_BOX) return null;
  const box = { s: r(b.s), w: r(b.w), n: r(b.n), e: r(b.e) };
  const isRect =
    pts.length === 4 &&
    pts.every((p) => (p[0] === box.s || p[0] === box.n) && (p[1] === box.w || p[1] === box.e)) &&
    new Set(pts.map((p) => p.join())).size === 4;
  return isRect ? box : { ...box, pts };
}

/** Signed area in degrees² (shoelace); only used to reject flat shapes. */
function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [y1, x1] = pts[i];
    const [y2, x2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Corners of a box as a shape (its own pts, or the rectangle's four corners). */
export const boxPoints = (b) => (b.pts?.length >= 3 ? b.pts.map((p) => [...p]) : [[b.s, b.w], [b.n, b.w], [b.n, b.e], [b.s, b.e]]);

/** Firestore can't store nested arrays: [[lat, lon], ...] <-> [lat, lon, lat, lon, ...]. */
export const flatPoints = (pts) => pts.flat();
export function unflatPoints(list) {
  if (!Array.isArray(list) || list.length < 6 || list.length % 2) return null;
  const pts = [];
  for (let i = 0; i < list.length; i += 2) pts.push([list[i], list[i + 1]]);
  return pts.every((p) => p.every((x) => typeof x === 'number')) ? pts : null;
}

/** A box read from storage: edges plus optional flat points. */
export function storedBox(s, w, n, e, flat) {
  if (![s, w, n, e].every((x) => typeof x === 'number')) return null;
  const pts = unflatPoints(flat);
  return pts ? { s, w, n, e, pts } : { s, w, n, e };
}

/** The area stored on a profile doc, or null. */
export function profileBox(p) {
  if (!p) return null;
  return storedBox(p.boxS, p.boxW, p.boxN, p.boxE, p.boxPts);
}

/** A default starting box around a point: about 15 km in each direction. */
export function boxAround(lat, lon, km = 15) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

export const boxCenter = (b) => ({ lat: (b.s + b.n) / 2, lon: (b.w + b.e) / 2 });

/** Is the point inside the area? Checks the drawn shape when there is one. */
export function inBox(b, p) {
  if (!b || !p || !(p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e)) return false;
  return b.pts?.length >= 3 ? inPolygon(b.pts, p.lat, p.lon) : true;
}

/** Ray casting; points exactly on an edge may land either way. */
export function inPolygon(pts, lat, lon) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

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
