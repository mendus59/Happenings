#!/usr/bin/env node
// Daily job: restaurants inside each user's dine-in / takeout / delivery boxes, with menus and
// ordering links read from each restaurant's own website.
//   node scraper/src/restaurants/index.js                         # update Firestore
//   node scraper/src/restaurants/index.js --dry-run --box 47.50,-122.70,47.58,-122.58 --limit 8
//   node scraper/src/restaurants/index.js --dry-run --url https://example-restaurant.com/
import { parseArgs } from 'node:util';
import { areasForBoxes, restaurantQuery, restaurantFromElement, priceLevel, MODE_IDS } from '../../../shared/restaurants.js';
import { fetchOverpass } from '../../../shared/places.js';
import { normalizeBox } from '../../../shared/geo.js';
import { launchBrowser } from '../browser.js';
import { scrapeMenu } from '../menu/scrapeMenu.js';

const DAY = 864e5;
const OSM_EVERY_DAYS = Number(process.env.RESTAURANT_OSM_EVERY_DAYS || 7);
const MENU_EVERY_DAYS = Number(process.env.MENU_EVERY_DAYS || 30);
const MENU_RETRY_DAYS = 7;
const MENU_BUDGET = Number(process.env.MENU_BUDGET || 120); // websites visited per run
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 35) * 60e3;
const CONCURRENCY = 3;
const CHUNK_BYTES = 700_000; // Firestore documents max out at 1 MiB
const OVERPASS_UA = 'Happenings/1.0 (+https://github.com/mendus59/Happenings)';

const isMain = import.meta.url === `file://${process.argv[1]}`;
const { values: args } = parseArgs({
  args: isMain ? process.argv.slice(2) : [],
  options: {
    'dry-run': { type: 'boolean', default: false },
    box: { type: 'string' },
    url: { type: 'string', multiple: true },
    limit: { type: 'string', default: '6' },
  },
});
const log = (...a) => console.log(...a);
const started = Date.now();

export async function fetchRestaurants(box) {
  const json = await fetchOverpass(restaurantQuery(box), {
    headers: { 'user-agent': OVERPASS_UA, accept: 'application/json' },
    timeoutMs: 120000,
    rounds: 3,
  });
  const byId = new Map();
  for (const el of json.elements || []) {
    const r = restaurantFromElement(el);
    if (r) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Pure: combine what the map says with what the website says. */
export function combine(osm, site = {}) {
  const pick = (k) => (osm[k] === false ? (site[k] ? true : false) : osm[k] || site[k] ? true : null);
  const items = site.m || [];
  return {
    ...osm,
    osm: { dine: osm.dine, takeout: osm.takeout, delivery: osm.delivery },
    dine: pick('dine'),
    takeout: pick('takeout'),
    delivery: pick('delivery'),
    m: items,
    price: priceLevel(items),
    menuUrl: site.menuUrl || osm.menuUrl || '',
    menuSource: site.menuSource || '',
    orderLinks: site.orderLinks || (osm.orderUrl ? [{ id: 'direct', label: 'Order online', url: osm.orderUrl, takeout: true }] : []),
    closure: site.closure || null,
    menuCheckedAt: site.menuCheckedAt || 0,
    menuError: site.menuError || '',
  };
}

const siteFields = (r) =>
  r && {
    m: r.m,
    menuUrl: r.menuUrl,
    menuSource: r.menuSource,
    orderLinks: r.orderLinks,
    closure: r.closure,
    menuCheckedAt: r.menuCheckedAt,
    menuError: r.menuError,
    dine: r.osm?.dine !== true && r.dine === true ? true : undefined,
    takeout: r.osm?.takeout !== true && r.takeout === true ? true : undefined,
    delivery: r.osm?.delivery !== true && r.delivery === true ? true : undefined,
  };

async function visit(browser, r) {
  try {
    const res = await scrapeMenu(browser, r, { log: () => {} });
    return {
      m: res.items,
      menuUrl: res.menuUrl,
      menuSource: res.menuSource,
      orderLinks: res.orderLinks,
      closure: res.closure ? { text: res.closure, at: Date.now() } : null,
      dine: res.dine,
      takeout: res.takeout,
      delivery: res.delivery,
      menuCheckedAt: Date.now(),
      menuError: '',
    };
  } catch (e) {
    return { menuCheckedAt: Date.now(), menuError: String(e.message || e).slice(0, 200) };
  }
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length && Date.now() - started < TIME_BUDGET_MS) await fn(list[i++]);
    }),
  );
}

/** Pure: split restaurants into documents under the size limit. */
export function chunk(list, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const r of list) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > maxBytes) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const needsMenu = (r, now) =>
  r.website && (!r.menuCheckedAt || now - r.menuCheckedAt > (r.menuError ? MENU_RETRY_DAYS : MENU_EVERY_DAYS) * DAY);

async function dryRun() {
  const browser = await launchBrowser();
  try {
    let list = [];
    if (args.box) {
      const [s, w, n, e] = args.box.split(',').map(Number);
      const box = normalizeBox({ s, w, n, e });
      list = await fetchRestaurants(box);
      log(`Restaurants on the map in the box: ${list.length} (${list.filter((r) => r.website).length} with a website)`);
      const by = (k) => list.filter((r) => r[k] === true).length;
      log(`  Map says: dine-in ${by('dine')}, takeout ${by('takeout')}, delivery ${by('delivery')}`);
      list = list.filter((r) => r.website).slice(0, Number(args.limit));
    }
    for (const url of args.url || []) list.push({ id: 'cli', name: url, website: url });
    for (const r of list) {
      const t0 = Date.now();
      const site = await visit(browser, r);
      const c = combine(r, site);
      log(`\n${r.name} — ${r.website} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      if (site.menuError) log(`  error: ${site.menuError}`);
      log(`  menu: ${c.m.length} items via ${c.menuSource || '-'} ${c.menuUrl ? `from ${c.menuUrl}` : ''}; price ${'$'.repeat(c.price) || '?'}`);
      for (const i of c.m.slice(0, 5)) log(`   - ${i.s ? `[${i.s}] ` : ''}${i.n}${i.p != null ? ` $${i.p}` : ''}${i.d ? ` — ${i.d.slice(0, 60)}` : ''}`);
      log(`  order: ${c.orderLinks.map((o) => `${o.label} <${o.url}>`).join(', ') || 'none found'}`);
      log(`  dine-in ${c.dine}, takeout ${c.takeout}, delivery ${c.delivery}${c.closure ? `, CLOSING? ${c.closure.text.slice(0, 80)}` : ''}`);
    }
  } finally {
    await browser.close();
  }
}

async function run() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set.');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();

  // Each user's three boxes become one to three shared areas.
  const boxesByUser = new Map();
  for (const d of (await db.collectionGroup('restaurantAreas').get()).docs) {
    if (!MODE_IDS.includes(d.id)) continue;
    const uid = d.ref.parent.parent.id;
    const { s, w, n, e } = d.data();
    if (!boxesByUser.has(uid)) boxesByUser.set(uid, []);
    boxesByUser.get(uid).push({ s, w, n, e });
  }
  const areas = new Map();
  for (const boxes of boxesByUser.values()) for (const a of areasForBoxes(boxes)) areas.set(a.id, a);
  log(`${boxesByUser.size} users, ${areas.size} restaurant areas`);
  if (!areas.size) return;

  const browser = await launchBrowser();
  const visited = new Map(); // restaurant id -> site fields (shared across overlapping areas)
  let budget = MENU_BUDGET;
  try {
    for (const area of areas.values()) {
      const areaRef = db.doc(`rareas/${area.id}`);
      const meta = (await areaRef.get()).data() || {};
      const chunkDocs = await areaRef.collection('chunks').get();
      const existing = new Map();
      for (const d of chunkDocs.docs) for (const r of d.get('list') || []) existing.set(r.id, r);

      let osmList = [...existing.values()].map((r) => ({ ...r, ...r.osm }));
      let osmUpdated = false;
      if (!existing.size || Date.now() - (meta.lastOsmAt?.toMillis?.() || 0) > OSM_EVERY_DAYS * DAY) {
        try {
          const fresh = await fetchRestaurants(area);
          if (existing.size && fresh.length < existing.size * 0.7) log(`  ${area.id}: map answer looks incomplete (${fresh.length} vs ${existing.size}); keeping the old list`);
          else {
            osmList = fresh;
            osmUpdated = true;
          }
        } catch (e) {
          log(`  ${area.id}: map lookup failed: ${e.message}`);
          if (!existing.size) continue;
        }
      }

      const now = Date.now();
      let list = osmList.map((o) => combine(o, visited.get(o.id) || siteFields(existing.get(o.id))));
      const todo = list
        .filter((r) => needsMenu(r, now) && !visited.has(r.id))
        .sort((a, b) => (a.menuCheckedAt || 0) - (b.menuCheckedAt || 0))
        .slice(0, Math.max(0, budget));
      budget -= todo.length;
      let read = 0;
      await pool(todo, CONCURRENCY, async (r) => {
        const site = await visit(browser, r);
        visited.set(r.id, site);
        if (site.m?.length) read++;
      });
      list = osmList.map((o) => combine(o, visited.get(o.id) || siteFields(existing.get(o.id))));
      list.sort((a, b) => a.name.localeCompare(b.name));

      const chunks = chunk(list);
      const batch = db.batch();
      chunks.forEach((c, i) => batch.set(areaRef.collection('chunks').doc(String(i)), { list: c }));
      for (const d of chunkDocs.docs) if (Number(d.id) >= chunks.length) batch.delete(d.ref);
      batch.set(
        areaRef,
        {
          s: area.s,
          w: area.w,
          n: area.n,
          e: area.e,
          count: list.length,
          chunks: chunks.length,
          withMenu: list.filter((r) => r.m.length).length,
          updatedAt: FieldValue.serverTimestamp(),
          ...(osmUpdated ? { lastOsmAt: FieldValue.serverTimestamp() } : {}),
        },
        { merge: true },
      );
      await batch.commit();
      log(`  ${area.id}: ${list.length} restaurants, visited ${todo.length} sites (${read} menus read), ${chunks.length} chunks`);
    }
  } finally {
    await browser.close();
  }
}

if (isMain) {
  (args['dry-run'] ? dryRun : run)().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
