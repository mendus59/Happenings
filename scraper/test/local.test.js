import test from 'node:test';
import assert from 'node:assert/strict';
import { openingsFromLcbRows } from '../src/local/licenses.js';
import { diffOsm, snapshotOf } from '../src/local/osm.js';
import { detectClosure } from '../src/closure.js';

test('license notices become openings for food and drink places only', () => {
  const rows = [
    {
      license: '123456', l_a_type: 'NEW LICENSE APPLICATION', applicationdate: '20261102', tradename: 'THE SALTY OYSTER',
      streetaddress: '700 BAY ST', city: 'PORT ORCHARD', privdesc01: 'S/B/W RESTAURANT LOUNGE (+)',
      location: { type: 'Point', coordinates: [-122.6363, 47.5404] },
    },
    { license: '2', l_a_type: 'NEW LICENSE APPLICATION', applicationdate: '20261102', tradename: 'GAS N GO', privdesc01: 'GROCERY STORE - BEER/WINE', location: { coordinates: [-122.6, 47.5] } },
    { license: '3', l_a_type: 'DISCONTINUED', applicationdate: '20261102', tradename: 'X', privdesc01: 'TAVERN - BEER/WINE', location: { coordinates: [-122.6, 47.5] } },
    { license: '4', l_a_type: 'ASSUMPTION OF A LICENSE', applicationdate: '20261101', tradename: 'VALHOLL BREWING', privdesc01: 'DOMESTIC BREWERY', location: 'POINT (-122.6465 47.7357)' },
    { license: '5', l_a_type: 'NEW LICENSE APPLICATION', tradename: 'NOWHERE CAFE', privdesc01: 'SNACK BAR' }, // no coordinates
  ];
  const out = openingsFromLcbRows(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'lcb_123456_20261102');
  assert.equal(out[0].name, 'The Salty Oyster');
  assert.equal(out[0].kind, 'restaurant');
  assert.equal(out[0].date, '2026-11-02');
  assert.equal(out[0].lat, 47.5404);
  assert.match(out[0].detail, /new liquor license/i);
  assert.equal(out[1].kind, 'brewery');
  assert.equal(out[1].lon, -122.6465);
  assert.match(out[1].detail, /New owner/);
});

test('map comparison finds new, closed, and vanished places', () => {
  const place = (id, extra = {}) => ({ id: `node/${id}`, name: `P${id}`, kind: 'restaurant', lat: 47.5, lon: -122.6, website: '', address: '', ...extra });
  const prev = snapshotOf([place(1), place(2), place(3)]);
  const current = snapshotOf([place(1), place(2, { closed: true }), place(4)]);
  assert.deepEqual(diffOsm(null, current, '2026-11-20'), []);
  const ids = diffOsm(prev, current, '2026-11-20').map((c) => c.id).sort();
  assert.deepEqual(ids, ['osm_closed_node_2', 'osm_gone_node_3', 'osm_open_node_4']);
});

test('closure notices on a venue site are spotted, temporary ones ignored', () => {
  assert.match(detectClosure('<body><p>After 22 years, we have closed our doors for good. Thank you!</p></body>'), /closed our doors for good/);
  assert.match(detectClosure('<body><h2>Permanently closed</h2></body>'), /Permanently closed/);
  assert.equal(detectClosure('<body><p>We are closed for Thanksgiving and will reopen Friday.</p></body>'), null);
  assert.equal(detectClosure('<body><p>Live music every Friday!</p></body>'), null);
});
