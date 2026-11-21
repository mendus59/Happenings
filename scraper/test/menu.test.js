import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMenu, menuFromLines } from '../src/menu/extract.js';
import { pdfToLines } from '../src/menu/pdf.js';
import { combine, chunk } from '../src/restaurants/index.js';
import { restaurantFromElement, priceLevel, areasForBoxes, serviceForUrl, deliverySearchLinks } from '../../shared/restaurants.js';

const fx = (f) => new URL(`./fixtures/menus/${f}`, import.meta.url);
const html = (f) => readFileSync(fx(f), 'utf8');

test('menu widget markup (Squarespace-style) with sections, prices and ordering links', () => {
  const r = extractMenu(html('squarespace.html'), 'https://thaiplace.example/');
  assert.equal(r.source, 'widget');
  assert.equal(r.items.length, 6);
  assert.deepEqual(r.items[0], { n: 'Spring Rolls', p: 8, d: 'Crispy rolls with cabbage, carrot and glass noodles', s: 'Appetizers' });
  assert.equal(r.items[2].p, 9.5);
  assert.equal(r.items[5].s, 'Noodles');
  assert.deepEqual(r.orderLinks.map((o) => o.id), ['doordash', 'toast']);
  assert.ok(r.orderLinks[0].delivery);
  assert.ok(r.hints.takeout && r.hints.dine);
});

test('the same menu without widget classes is read line by line', () => {
  const r = extractMenu(html('squarespace.html').replace(/class="[^"]*"/g, ''), 'https://thaiplace.example/');
  assert.equal(r.source, 'text');
  assert.deepEqual(r.items.map((i) => i.n), ['Spring Rolls', 'Chicken Satay', 'Tom Yum Soup', 'Pad Thai', 'Pad See Ew', 'Drunken Noodles']);
  assert.equal(r.items[3].d, 'Rice noodles, egg, tofu, bean sprouts, peanuts');
});

test('schema.org Menu JSON-LD', () => {
  const r = extractMenu(html('jsonld.html'), 'https://harborgrill.example/');
  assert.equal(r.source, 'jsonld');
  assert.equal(r.items.length, 6);
  assert.deepEqual(r.items[0], { n: 'Clam Chowder', p: 9, d: 'Manila clams, bacon, potato', s: 'Starters' });
  assert.equal(r.items[3].p, 18.5);
  assert.deepEqual(r.links, ['https://harborgrill.example/dinner-menu']);
  assert.equal(r.orderLinks[0].id, 'grubhub');
});

test('plain text menus: dotted leaders, inline descriptions, price on the next line; hours and gift cards ignored', () => {
  const r = extractMenu(html('plain.html'), 'https://diner.example/');
  assert.deepEqual(r.items.map((i) => [i.n, i.p]), [
    ['Two Egg Breakfast', 12.95],
    ['Biscuits & Gravy', 11.5],
    ['Country Fried Steak', 17],
    ['Patty Melt', 15],
    ['Clubhouse Sandwich', 14],
    ['BLT', 12],
  ]);
  assert.equal(r.items[2].d, 'with two eggs and hash browns');
  assert.equal(r.items[3].s, 'LUNCH');
});

test('a page that is not a menu yields no items, but its menu links (including PDFs) are found', () => {
  const r = extractMenu(html('notmenu.html'), 'https://cafe.example/');
  assert.equal(r.items.length, 0);
  assert.deepEqual(new Set(r.links), new Set(['https://cafe.example/our-menu', 'https://cafe.example/files/Dinner%20Menu.pdf']));
  assert.equal(r.orderLinks[0].id, 'direct');
});

test('two-column PDF menu is read in column order', async () => {
  const lines = await pdfToLines(readFileSync(fx('taqueria.pdf')));
  const items = menuFromLines(lines);
  assert.deepEqual(items.map((i) => [i.s, i.n, i.p]), [
    ['TACOS', 'Carne Asada Taco', 4.5],
    ['TACOS', 'Al Pastor Taco', 4.25],
    ['TACOS', 'Fish Taco', 5],
    ['PLATES', 'Burrito Mojado', 15.95],
    ['PLATES', 'Enchiladas Verdes', 16.5],
    ['PLATES', 'Chile Relleno', 17.25],
  ]);
  assert.equal(items[0].d, 'Grilled steak, onion, cilantro');
});

test('restaurants from map data: cuisines, dining options, ids', () => {
  const r = restaurantFromElement({
    type: 'node', id: 42, lat: 47.54, lon: -122.63,
    tags: { name: 'Thai Place', amenity: 'restaurant', cuisine: 'thai;noodle', takeaway: 'yes', delivery: 'no', website: 'thaiplace.example', 'addr:city': 'Port Orchard' },
  });
  assert.equal(r.id, 'r_node_42');
  assert.deepEqual(r.cuisines, ['Thai', 'Noodles']);
  assert.equal(r.website, 'https://thaiplace.example');
  assert.deepEqual([r.dine, r.takeout, r.delivery], [true, true, false]);
  const cafe = restaurantFromElement({ type: 'way', id: 7, center: { lat: 47.5, lon: -122.6 }, tags: { name: 'Bean', amenity: 'cafe', takeaway: 'only' } });
  assert.deepEqual([cafe.dine, cafe.takeout, cafe.delivery, cafe.cuisines[0]], [false, true, null, 'Coffee']);
  assert.equal(restaurantFromElement({ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'restaurant' } }), null);
});

test('combining map and website info', () => {
  const osm = { id: 'r_node_1', name: 'X', dine: true, takeout: null, delivery: false };
  const c = combine(osm, { m: [{ n: 'A', p: 14 }, { n: 'B', p: 16 }, { n: 'C', p: 18 }, { n: 'D', p: 22 }], takeout: true, delivery: true, orderLinks: [{ id: 'doordash' }] });
  assert.deepEqual([c.dine, c.takeout, c.delivery, c.price], [true, true, true, 2]);
  assert.deepEqual(c.osm, { dine: true, takeout: null, delivery: false });
  assert.deepEqual([combine(osm).delivery, combine(osm).price, combine(osm).m.length], [false, 0, 0]);
});

test('price level, ordering services, search links, chunking, areas', () => {
  assert.equal(priceLevel([{ p: 8 }, { p: 9 }, { p: 10 }, { p: 11 }]), 1);
  assert.equal(priceLevel([{ p: 40 }]), 0);
  assert.equal(serviceForUrl('https://order.toasttab.com/online/x').id, 'toast');
  assert.equal(serviceForUrl('https://www.seamless.com/menu/x').id, 'grubhub');
  assert.equal(serviceForUrl('https://example.com'), null);
  assert.match(deliverySearchLinks({ name: 'Thai Place', city: 'Port Orchard' })[0].url, /doordash\.com\/search\/store\/Thai%20Place%20Port%20Orchard/);
  const list = Array.from({ length: 10 }, (_, i) => ({ id: i, pad: 'x'.repeat(100) }));
  const parts = chunk(list, 300);
  assert.ok(parts.length > 1 && parts.flat().length === 10);
  // A small takeout box inside the dine-in box shares the dine-in area.
  const areas = areasForBoxes([
    { s: 47.4, w: -122.8, n: 47.8, e: -122.45 },
    { s: 47.5, w: -122.7, n: 47.58, e: -122.58 },
  ]);
  assert.equal(areas.length, 1);
  assert.equal(areas[0].n, 47.8);
});

test('PDF columns on different baselines are still read column by column', async () => {
  const { pageLines } = await import('../src/menu/pdf.js');
  const t = (s, x, y, w = s.length * 5) => ({ str: s, transform: [10, 0, 0, 10, x, y], width: w });
  const items = [];
  const left = ['STARTERS', 'Wings 14', 'Crispy and hot', 'Nachos 12', 'Beans and cheese', 'Fries 6'];
  const right = ['BURGERS', 'Smash Burger 16', 'Two patties, pickles', 'Veggie Burger 15', 'House black bean patty', 'Kids Burger 9'];
  left.forEach((s, i) => items.push(t(s, 40, 700 - i * 20)));
  right.forEach((s, i) => items.push(t(s, 330, 707 - i * 20)));
  assert.deepEqual(pageLines(items, 612), [...left, ...right]);
});

test('a one-column PDF with prices far right stays one column', async () => {
  const { pageLines } = await import('../src/menu/pdf.js');
  const t = (s, x, y, w = s.length * 5) => ({ str: s, transform: [10, 0, 0, 10, x, y], width: w });
  const items = [];
  ['Wings', 'Nachos', 'Fries', 'Salad', 'Soup', 'Burger'].forEach((s, i) => {
    items.push(t(s, 40, 700 - i * 30));
    items.push(t('Crispy, hot and served with ranch dressing', 40, 688 - i * 30));
    items.push(t('$' + (10 + i), 540, 703 - i * 30));
  });
  const lines = pageLines(items, 612);
  assert.equal(lines[0], 'Wings $10');
  assert.equal(lines[1], 'Crispy, hot and served with ranch dressing');
});

test('opening dates: map start_date, license notices, first seen on the map', async () => {
  const { withHistory } = await import('../src/restaurants/index.js');
  const { osmDate, sameName, openedOf } = await import('../../shared/restaurants.js');
  assert.equal(osmDate('2019-05'), '2019-05');
  assert.equal(osmDate('~1998'), '1998');
  assert.equal(osmDate('before 1990'), '');
  assert.ok(sameName('Bay Thai LLC', 'Bay Thai Restaurant'));
  assert.ok(sameName("Hall's Hill Cafe", 'Halls Hill'));
  assert.ok(!sameName('Bay Thai', 'Bay Pizza Co'));

  const thai = { id: 'r_node_1', name: 'Bay Thai', lat: 47.5406, lon: -122.6372, since: '' };
  const taco = { id: 'r_node_2', name: 'Kitsap Taqueria', lat: 47.545, lon: -122.63, since: '2015' };
  const notice = (license, name, lat, lon, date) => ({ license, name, lat, lon, date, licenseType: 'new', detail: 'Applied for a new liquor license: Beer/Wine Restaurant' });
  const notices = [
    notice('111', 'Bay Thai LLC', 47.5407, -122.6371, '2026-11-02'),
    notice('222', 'Brand New Bistro', 47.55, -122.64, '2026-11-10'),
  ];
  // First run: no history yet, so nothing counts as "first seen".
  let list = withHistory([thai, taco], new Map(), notices, { today: '2026-11-20', osmUpdated: true });
  const byId = new Map(list.map((r) => [r.id, r]));
  assert.equal(byId.get('r_node_1').license.date, '2026-11-02');
  assert.equal(byId.get('r_node_2').license, undefined);
  assert.equal(byId.get('r_node_2').firstSeen, undefined);
  assert.equal(byId.get('r_lcb_222').name, 'Brand New Bistro');
  assert.ok(byId.get('r_lcb_222').fromLicense);
  assert.deepEqual(openedOf(byId.get('r_node_2')), { date: '2015', src: 'map' });

  // Later run: the notices have left the feed, but the dates are kept. The bistro is now on
  // the map, so its license date moves to the mapped restaurant; a new place gets firstSeen.
  const bistro = { id: 'r_node_3', name: 'Brand New Bistro', lat: 47.5501, lon: -122.6401, since: '' };
  const fresh = { id: 'r_node_4', name: 'Pho Corner', lat: 47.54, lon: -122.63, since: '' };
  list = withHistory([thai, taco, bistro, fresh], byId, [], { today: '2026-12-01', osmUpdated: true });
  const after = new Map(list.map((r) => [r.id, r]));
  assert.equal(after.get('r_node_1').license.date, '2026-11-02');
  assert.equal(after.get('r_node_3').license.date, '2026-11-10');
  assert.equal(after.has('r_lcb_222'), false);
  assert.equal(after.get('r_node_4').firstSeen, '2026-12-01');
  assert.equal(after.get('r_node_3').firstSeen, '2026-12-01');
  assert.deepEqual(openedOf(after.get('r_node_3')), { date: '2026-11-10', src: 'license' });

  // License-only places are dropped after a year.
  const old = new Map([['r_lcb_9', { id: 'r_lcb_9', name: 'Gone', lat: 47.5, lon: -122.6, license: { date: '2025-01-01' } }]]);
  assert.equal(withHistory([], old, [], { today: '2026-11-20', osmUpdated: false }).length, 0);
});

test('state licensee list: rows to licenses, geocoder answers, opening notices', async () => {
  const { licenseesFromRows, noticeFromLicensee, onPremiseUrlFrom } = await import('../src/local/lcbList.js');
  const { parseBatch, addressKey } = await import('../src/local/geocode.js');
  const head = ['Tradename', 'License Number', 'ID Number', 'Loc Address', 'Loc Room', 'Loc City', 'Loc St', 'Loc Zip', 'Phone', 'Mail Address', 'Mail City', 'Mail State', 'Mail Zip', 'Business Startup Date', 'Issue Date', 'Expire Date', 'Privilege', 'Application Date', 'Reason Description', 'County', 'Status', 'Night Phone', 'Licensee', 'Temporary License'];
  const row = (name, lic, addr, city, priv, applied, reason, status, issued = '20260912') => [name, lic, '', addr, '', city, 'WA', '983666401', '', '', '', '', '', '20260722', issued, '20270930', priv, applied, reason, 'KITSAP', status, '', '', ''];
  const rows = [
    head,
    row("MOONBEEM'S THAI'SH CAFE                       ", '453605', '1386 SE LUND AVE STE 110       ', 'PORT ORCHARD             ', 'SPIRITS/BR/WN REST LOUNGE +', '20260806', 'ASSUMPTION', 'ACTIVE (ISSUED)'),
    row('EL PUEBLITO', '082120', '1948 SE LUND AVE STE 102', 'PORT ORCHARD', 'SPIRITS/BR/WN REST LOUNGE +', '20261008', 'RENEWAL', 'ACTIVE (ISSUED)'),
    row('028 BARBER SHOP', '426995', '1 MAIN ST', 'PORT ORCHARD', 'SNACK BAR', '20260331', 'RENEWAL', 'ACTIVE (ISSUED)'),
    row('OLD PLACE', '111', '2 MAIN ST', 'PORT ORCHARD', 'BEER/WINE REST - BEER/WINE', '20250101', 'RENEWAL', 'EXPIRED'),
    row('NEW SPOT', '222', '3 BAY ST', 'PORT ORCHARD', 'BEER/WINE REST - BEER/WINE', '20261101', 'NEW APPLICATION', 'PENDING (NON-ISSUED)', ''),
  ];
  const list = licenseesFromRows(rows);
  assert.deepEqual(list.map((l) => l.license), ['453605', '082120', '222']);
  const moon = list[0];
  assert.equal(moon.name, "Moonbeem's Thai'sh Cafe");
  assert.equal(moon.zip, '98366');
  const n = noticeFromLicensee(moon, 47.52, -122.61);
  assert.equal(n.date, '2026-08-06');
  assert.equal(n.licenseType, 'new-owner');
  assert.equal(n.kind, 'restaurant');
  assert.match(n.detail, /issued 2026-09-12/);
  assert.equal(noticeFromLicensee(list[1], 47.5, -122.6).date, '', 'renewals carry no opening date');
  assert.equal(noticeFromLicensee(list[2], 47.5, -122.6).status, 'pending');
  assert.equal(
    onPremiseUrlFrom('<a href="/sites/default/files/2026-11/Off%20Premise11172026.xlsx">x</a><a href="https://lcb.wa.gov/sites/default/files/2026-11/On%20Premise11172026.xlsx">y</a>'),
    'https://lcb.wa.gov/sites/default/files/2026-11/On%20Premise11172026.xlsx',
  );
  const parsed = parseBatch('"0","1386 SE LUND AVE, PORT ORCHARD, WA, 98366","Match","Exact","1386 SE LUND AVE, PORT ORCHARD, WA, 98366","-122.6146,47.5203","123","L"\n"1","3 BAY ST, PORT ORCHARD, WA, 98366","No_Match"');
  assert.deepEqual(parsed, { 0: { lat: 47.5203, lon: -122.6146 }, 1: null });
  assert.equal(addressKey(moon), '1386 SE LUND AVE STE 110|PORT ORCHARD|98366');

  // Undated licensed restaurant not on the map becomes an entry; a bar does not.
  const { withHistory } = await import('../src/restaurants/index.js');
  const out = withHistory([], new Map(), [n, { ...noticeFromLicensee(list[1], 47.53, -122.61) }, { ...n, license: '9', name: 'Some Bar', kind: 'bar' }], { today: '2026-11-21', osmUpdated: true });
  assert.deepEqual(out.map((r) => [r.id, r.license?.date || '', r.licStatus]), [['r_lcb_453605', '2026-08-06', 'active'], ['r_lcb_082120', '', 'active']]);
});
