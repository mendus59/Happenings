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
