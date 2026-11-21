import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBox, normalizeShape, areaFor, inBox, profileBox, boxAround, boxPoints, flatPoints, unflatPoints, MAX_BOX } from './geo.js';

// Roughly Port Orchard to Poulsbo, leaving out Seattle across the water.
const kitsap = { s: 47.453, w: -122.712, n: 47.761, e: -122.581 };

test('normalizeBox rounds outward to 0.01°', () => {
  assert.deepEqual(normalizeBox(kitsap), { s: 47.45, w: -122.72, n: 47.77, e: -122.58 });
});

test('normalizeBox orders swapped edges', () => {
  assert.deepEqual(normalizeBox({ s: kitsap.n, n: kitsap.s, w: kitsap.e, e: kitsap.w }), normalizeBox(kitsap));
});

test('normalizeBox shrinks oversized boxes and rejects tiny or broken ones', () => {
  const big = normalizeBox({ s: 45, w: -125, n: 49, e: -118 });
  assert.ok(big.n - big.s <= MAX_BOX.lat + 1e-9);
  assert.ok(big.e - big.w <= MAX_BOX.lon + 1e-9);
  assert.equal(normalizeBox({ s: 47.5, w: -122.6, n: 47.505, e: -122.595 }), null);
  assert.equal(normalizeBox({ s: NaN, w: 1, n: 2, e: 3 }), null);
  assert.equal(normalizeBox(null), null);
});

test('areaFor snaps outward to a shared 0.05° grid', () => {
  const a = areaFor(kitsap);
  assert.deepEqual({ s: a.s, w: a.w, n: a.n, e: a.e }, { s: 47.45, w: -122.75, n: 47.8, e: -122.55 });
  assert.equal(a.id, 'a_47p45_m122p75_47p80_m122p55');
  // A slightly different box nearby shares the same area.
  assert.equal(areaFor({ ...kitsap, s: 47.46 }).id, a.id);
  assert.equal(areaFor(null), null);
});

test('inBox: Poulsbo is in, Seattle is out', () => {
  const b = normalizeBox(kitsap);
  assert.ok(inBox(b, { lat: 47.7357, lon: -122.6465 })); // Poulsbo
  assert.ok(inBox(b, { lat: 47.5404, lon: -122.6363 })); // Port Orchard
  assert.ok(!inBox(b, { lat: 47.6062, lon: -122.3321 })); // Seattle
});

test('profileBox needs all four edges', () => {
  assert.deepEqual(profileBox({ boxS: 1, boxW: 2, boxN: 3, boxE: 4 }), { s: 1, w: 2, n: 3, e: 4 });
  assert.equal(profileBox({ boxS: 1, boxW: 2, boxN: 3 }), null);
  assert.equal(profileBox(null), null);
});

test('boxAround makes a usable starting box', () => {
  const b = normalizeBox(boxAround(47.54, -122.64));
  assert.ok(b && inBox(b, { lat: 47.54, lon: -122.64 }));
});

test('shapes: corners rounded, bounding box kept, rectangle stays a plain box', () => {
  const b = normalizeShape([[47.401, -122.701], [47.6, -122.6], [47.45, -122.5]]);
  assert.deepEqual(b, { s: 47.4, w: -122.7, n: 47.6, e: -122.5, pts: [[47.4, -122.7], [47.6, -122.6], [47.45, -122.5]] });
  assert.deepEqual(normalizeShape([[47.4, -122.7], [47.6, -122.7], [47.6, -122.5], [47.4, -122.5]]), { s: 47.4, w: -122.7, n: 47.6, e: -122.5 });
  assert.equal(normalizeShape([[47.4, -122.7], [47.5, -122.6], [47.6, -122.5]]), null, 'flat line');
  assert.equal(normalizeShape([[47.4, -122.7], [47.41, -122.7]]), null, 'too few corners');
  const big = normalizeShape([[46, -124], [48.5, -124], [47, -120]]);
  assert.ok(big.n - big.s <= MAX_BOX.lat + 1e-9 && big.e - big.w <= MAX_BOX.lon + 1e-9);
});

test('inBox follows the shape: Port Orchard side of the water in, Seattle out', () => {
  // A triangle-ish area west of Puget Sound whose bounding box would include Seattle.
  const area = normalizeBox({ pts: [[47.4, -122.75], [47.8, -122.75], [47.75, -122.55], [47.45, -122.55]] });
  const box = { s: 47.4, w: -122.75, n: 47.8, e: -122.3 };
  const withSeattleCorner = normalizeBox({ pts: [[47.4, -122.75], [47.8, -122.75], [47.8, -122.3], [47.6, -122.55], [47.4, -122.55]] });
  assert.ok(inBox(area, { lat: 47.54, lon: -122.64 }), 'Port Orchard');
  assert.ok(inBox(box, { lat: 47.61, lon: -122.33 }), 'box contains Seattle');
  assert.ok(!inBox(withSeattleCorner, { lat: 47.52, lon: -122.4 }), 'notch outside the shape');
  assert.ok(inBox(withSeattleCorner, { lat: 47.78, lon: -122.45 }), 'inside the arm');
});

test('stored shapes round-trip through flat lists', () => {
  const pts = [[47.4, -122.7], [47.6, -122.6], [47.45, -122.5]];
  assert.deepEqual(unflatPoints(flatPoints(pts)), pts);
  assert.deepEqual(profileBox({ boxS: 47.4, boxW: -122.7, boxN: 47.6, boxE: -122.5, boxPts: flatPoints(pts) }).pts, pts);
  assert.equal(profileBox({ boxS: 1, boxW: 1, boxN: 2, boxE: 2 }).pts, undefined);
  assert.deepEqual(boxPoints({ s: 1, w: 2, n: 3, e: 4 }), [[1, 2], [3, 2], [3, 4], [1, 4]]);
});
