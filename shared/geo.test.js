import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBox, areaFor, inBox, profileBox, boxAround, MAX_BOX } from './geo.js';

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
