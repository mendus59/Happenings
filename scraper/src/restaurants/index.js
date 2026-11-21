#!/usr/bin/env node
// Daily job: restaurants inside each user's dine-in / takeout / delivery boxes, with menus and
// ordering links read from each restaurant's own website.
//   node scraper/src/restaurants/index.js                         # update Firestore
//   node scraper/src/restaurants/index.js --dry-run --box 47.50,-122.70,47.58,-122.58 --limit 8
//   node scraper/src/restaurants/index.js --dry-run --url https://example-restaurant.com/
import { parseArgs } from 'node:util';
import {
  areasForBoxes,
  restaurantQuery,
  restaurantFromElement,
  priceLevel,
  matchLicense,
  licenseRestaurantId,
  MODE_IDS,
} from '../../../shared/restaurants.js';
import { fetchOverpass } from '../../../shared/places.js';
import { inBox, normalizeBox } from '../../../shared/geo.js';
import { launchBrowser } from '../browser.js';
import { scrapeMenu } from '../menu/scrapeMenu.js';
import { fetchLcbOpenings } from '../local/licenses.js';

const DAY = 864e5;
const OSM_EVERY_DAYS = Number(process.env.RESTAURANT_OSM_EVERY_DAYS || 7);
const MENU_EVERY_DAYS = Number(process.env.MENU_EVERY_DAYS || 30);
const MENU_RETRY_DAYS = 7;
// Bump when the menu reader improves: menus read by an older version are read again.
export const MENU_VERSION = 2;
const MENU_BUDGET = Number(process.env.MENU_BUDGET || 120); // websites visited per run
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 35) * 60e3;
const VISIT_LIMIT_MS = 120e3; // give up on one website after this, so one bad site can't stall the run
const SAVE_EVERY = 20; // save progress after this many websites
const LICENSE_KEEP_DAYS = 365; // places known only from a license notice are dropped after this
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
    dump: { type: 'string' }, // folder to save each page read (for improving the menu reader)
    // Only set up areas that have no saved list yet (map + license notices, no menus). Fast,
    // so it runs hourly and new areas don't wait for the nightly run.
    quick: { type: 'boolean', default: false },
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
    menuV: site.menuV || 1,
  };
}

const licenseOf = (n) => ({ date: n.date, type: n.licenseType || 'new', detail: n.detail || '' });

/**
 * Pure: carry opening dates forward and fold in liquor-license notices.
 *  - license: the newest notice matched to a restaurant (name + within 250 m)
 *  - firstSeen: the day a restaurant first showed up on the map (only after the first list)
 *  - restaurants known only from a notice (not mapped yet) are kept for a year, and handed
 *    over to the mapped restaurant once it appears.
 */
export function withHistory(osmList, existing, notices, { today, osmUpdated }) {
  const hadList = [...existing.values()].some((r) => !String(r.id).startsWith('r_lcb_'));
  const list = osmList
    .filter((o) => !String(o.id).startsWith('r_lcb_'))
    .map((o) => {
      const prev = existing.get(o.id);
      const r = { ...o };
      if (prev?.license) r.license = prev.license;
      if (prev?.firstSeen) r.firstSeen = prev.firstSeen;
      else if (!prev && hadList && osmUpdated) r.firstSeen = today;
      return r;
    });
  const newer = (a, b) => !a || String(b.date) > String(a.date);
  const licensed = new Map();
  // Earlier license-only places: hand over to a mapped restaurant, else keep for a while.
  for (const prev of existing.values()) {
    if (!String(prev.id).startsWith('r_lcb_') || !prev.license) continue;
    const m = matchLicense(list, prev);
    if (m) {
      if (newer(m.license, prev.license)) m.license = prev.license;
    } else if (Date.parse(today) - Date.parse(prev.license.date) <= LICENSE_KEEP_DAYS * DAY) {
      licensed.set(prev.id, { ...prev });
    }
  }
  for (const n of notices) {
    if (!n.date || !n.license) continue;
    const m = matchLicense(list, n);
    if (m) {
      if (newer(m.license, n)) m.license = licenseOf(n);
      continue;
    }
    const id = licenseRestaurantId(n);
    const prev = licensed.get(id);
    if (prev && !newer(prev.license, n)) continue;
    licensed.set(id, {
      id,
      name: n.name,
      kind: 'restaurant',
      lat: Number(n.lat.toFixed(6)),
      lon: Number(n.lon.toFixed(6)),
      cuisines: [],
      website: '',
      phone: '',
      address: n.address || '',
      city: '',
      hours: '',
      dine: null,
      takeout: null,
      delivery: null,
      orderUrl: '',
      menuUrl: '',
      since: '',
      fromLicense: true,
      license: licenseOf(n),
    });
  }
  return [...list, ...licensed.values()];
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
    menuV: r.menuV,
    dine: r.osm?.dine !== true && r.dine === true ? true : undefined,
    takeout: r.osm?.takeout !== true && r.takeout === true ? true : undefined,
    delivery: r.osm?.delivery !== true && r.delivery === true ? true : undefined,
  };

async function visit(browser, r, dump) {
  let timer;
  try {
    const res = await Promise.race([
      scrapeMenu(browser, r, { log: () => {}, dump }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`gave up after ${VISIT_LIMIT_MS / 1000}s`)), VISIT_LIMIT_MS);
      }),
    ]);
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
      menuV: MENU_VERSION,
    };
  } catch (e) {
    return { menuCheckedAt: Date.now(), menuError: String(e.message || e).slice(0, 200), menuV: MENU_VERSION };
  } finally {
    clearTimeout(timer);
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

export const needsMenu = (r, now) =>
  !!r.website &&
  (!r.menuCheckedAt || (r.menuV || 1) < MENU_VERSION || now - r.menuCheckedAt > (r.menuError ? MENU_RETRY_DAYS : MENU_EVERY_DAYS) * DAY);

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
      const notices = (await fetchLcbOpenings(log)).filter((n) => inBox(box, n));
      const hist = withHistory(list, new Map(), notices, { today: new Date().toISOString().slice(0, 10), osmUpdated: true });
      log(`  License notices in the box: ${notices.length}`);
      for (const r of hist.filter((x) => x.license)) log(`   - ${r.license.date} ${r.name}${r.fromLicense ? ' (not on the map yet)' : ''}`);
      log(`  With an opening date on the map: ${list.filter((r) => r.since).length}`);
      list = list.filter((r) => r.website).slice(0, Number(args.limit));
    }
    for (const url of args.url || []) list.push({ id: 'cli', name: url, website: url });
    let dump;
    if (args.dump) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(args.dump, { recursive: true });
      let n = 0;
      dump = (url, ext, content) => {
        const name = `${String(++n).padStart(3, '0')}-${url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.${ext}`;
        writeFileSync(`${args.dump}/${name}`, content || '');
      };
    }
    for (const r of list) {
      const t0 = Date.now();
      const site = await visit(browser, r, dump);
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

  let todoAreas = [...areas.values()];
  if (args.quick) {
    const metas = await Promise.all(todoAreas.map((a) => db.doc(`rareas/${a.id}`).get()));
    todoAreas = todoAreas.filter((_, i) => !metas[i].exists);
    log(`quick: ${todoAreas.length} new areas`);
    if (!todoAreas.length) return;
  }
  const notices = await fetchLcbOpenings(log);
  const today = new Date().toISOString().slice(0, 10);
  let browser = null;
  const visited = new Map(); // restaurant id -> site fields (shared across overlapping areas)
  let budget = args.quick ? 0 : MENU_BUDGET;
  try {
    for (const area of todoAreas) {
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

      osmList = withHistory(osmList, existing, notices.filter((n) => inBox(area, n)), { today, osmUpdated });
      const build = () =>
        osmList.map((o) => combine(o, visited.get(o.id) || siteFields(existing.get(o.id)))).sort((a, b) => a.name.localeCompare(b.name));
      let chunkCount = chunkDocs.size;
      let saving = Promise.resolve();
      // Save the whole list; called before menus (so the area works right away), during, and after.
      const save = (list) =>
        (saving = saving.then(async () => {
          const chunks = chunk(list);
          const batch = db.batch();
          chunks.forEach((c, i) => batch.set(areaRef.collection('chunks').doc(String(i)), { list: c }));
          for (let i = chunks.length; i < chunkCount; i++) batch.delete(areaRef.collection('chunks').doc(String(i)));
          chunkCount = chunks.length;
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
              licensed: list.filter((r) => r.license).length,
              updatedAt: FieldValue.serverTimestamp(),
              ...(osmUpdated ? { lastOsmAt: FieldValue.serverTimestamp() } : {}),
            },
            { merge: true },
          );
          await batch.commit();
        }));

      let list = build();
      await save(list);
      const now = Date.now();
      const todo = list
        .filter((r) => needsMenu(r, now) && !visited.has(r.id))
        .sort((a, b) => (a.menuCheckedAt || 0) - (b.menuCheckedAt || 0))
        .slice(0, Math.max(0, budget));
      budget -= todo.length;
      if (todo.length && !browser) browser = await launchBrowser();
      let read = 0;
      let done = 0;
      await pool(todo, CONCURRENCY, async (r) => {
        const t0 = Date.now();
        const site = await visit(browser, r);
        visited.set(r.id, site);
        if (site.m?.length) read++;
        log(`    ${r.name}: ${site.m?.length || 0} items${site.menuError ? ` (${site.menuError.slice(0, 60)})` : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (++done % SAVE_EVERY === 0) await save(build());
      });
      list = build();
      await save(list);
      const chunks = { length: chunkCount };
      log(`  ${area.id}: ${list.length} restaurants (${list.filter((r) => r.license).length} with license notices), visited ${todo.length} sites (${read} menus read), ${chunks.length} chunks`);
    }
  } finally {
    await browser?.close();
  }
}

if (isMain) {
  (args['dry-run'] ? dryRun : run)().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
