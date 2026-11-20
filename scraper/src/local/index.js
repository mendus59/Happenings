#!/usr/bin/env node
// Daily job: openings and closings near each user's home area.
//   node scraper/src/local/index.js                       # update Firestore
//   node scraper/src/local/index.js --dry-run --box 47.40,-122.80,47.80,-122.45   (south,west,north,east)
import { parseArgs } from 'node:util';
import { areaFor, inBox, profileBox } from '../../../shared/geo.js';
import { areasForBoxes, MODE_IDS } from '../../../shared/restaurants.js';
import { fetchLcbOpenings } from './licenses.js';
import { fetchOsmPlaces, diffOsm, snapshotOf } from './osm.js';

const OSM_EVERY_DAYS = Number(process.env.OSM_EVERY_DAYS || 28);
const SNAPSHOT_CHUNK = 2500;

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    box: { type: 'string' },
  },
});
const log = (...a) => console.log(...a);
const today = new Date().toISOString().slice(0, 10);
const within = (area, p) => inBox(area, p);

async function dryRun() {
  const [s, w, n, e] = String(args.box || '').split(',').map(Number);
  const area = areaFor({ s, w, n, e });
  if (!area) throw new Error('Pass --box south,west,north,east');
  log(`Area ${area.id}`);
  const lcb = (await fetchLcbOpenings(log)).filter((o) => within(area, o));
  log(`\nLicense notices nearby: ${lcb.length}`);
  for (const o of lcb) log(` - ${o.date} ${o.name} (${o.address}) — ${o.detail}`);
  const places = await fetchOsmPlaces(area);
  log(`\nFood & drink places on the map nearby: ${places.length}`);
  for (const p of places.slice(0, 10)) log(` - ${p.name} [${p.kind}] ${p.website || ''}`);
}

async function run() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set.');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();

  // Areas people have set up: their home box plus their restaurant boxes (deduplicated
  // the same way the web app does, so both agree on area ids).
  const boxesByUser = new Map();
  const add = (uid, b) => b && (boxesByUser.get(uid) || boxesByUser.set(uid, []).get(uid)).push(b);
  for (const u of (await db.collection('users').get()).docs) add(u.id, profileBox(u.data()));
  for (const d of (await db.collectionGroup('restaurantAreas').get()).docs) {
    if (MODE_IDS.includes(d.id)) add(d.ref.parent.parent.id, d.data());
  }
  const areas = new Map();
  for (const boxes of boxesByUser.values()) for (const a of areasForBoxes(boxes)) areas.set(a.id, a);
  log(`${areas.size} areas`);
  if (!areas.size) return;

  const lcb = await fetchLcbOpenings(log);
  for (const area of areas.values()) {
    const areaRef = db.doc(`areas/${area.id}`);
    const snap = await areaRef.get();
    const changes = lcb.filter((o) => within(area, o));

    // Monthly map comparison.
    const lastOsm = snap.get('lastOsmAt')?.toMillis?.() || 0;
    let osmUpdate = {};
    if (Date.now() - lastOsm >= OSM_EVERY_DAYS * 864e5) {
      try {
        const current = snapshotOf(await fetchOsmPlaces(area));
        const prevDocs = await areaRef.collection('snapshots').get();
        const prev = prevDocs.empty ? null : Object.assign({}, ...prevDocs.docs.map((d) => d.get('places') || {}));
        const osmChanges = diffOsm(prev, current, today);
        // Guard against a partial Overpass answer wiping the map.
        if (prev && Object.keys(current).length < Object.keys(prev).length * 0.7) {
          log(`  ${area.id}: map answer looks incomplete (${Object.keys(current).length} vs ${Object.keys(prev).length}); skipping`);
        } else {
          changes.push(...osmChanges);
          const entries = Object.entries(current);
          const batch = db.batch();
          prevDocs.docs.forEach((d) => batch.delete(d.ref));
          for (let i = 0; i * SNAPSHOT_CHUNK < entries.length; i++) {
            batch.set(areaRef.collection('snapshots').doc(`osm_${i}`), {
              places: Object.fromEntries(entries.slice(i * SNAPSHOT_CHUNK, (i + 1) * SNAPSHOT_CHUNK)),
            });
          }
          await batch.commit();
          osmUpdate = { lastOsmAt: FieldValue.serverTimestamp(), placeCount: entries.length };
          log(`  ${area.id}: ${entries.length} places on the map, ${osmChanges.length} changes`);
        }
      } catch (e) {
        log(`  ${area.id}: map check failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 5000)); // be gentle with the public Overpass server
    }

    // Write changes (ids are stable, so re-runs don't duplicate).
    const existing = new Set((await areaRef.collection('changes').select().get()).docs.map((d) => d.id));
    const fresh = changes.filter((c) => !existing.has(c.id));
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = db.batch();
      for (const { id, ...c } of fresh.slice(i, i + 400)) {
        batch.set(areaRef.collection('changes').doc(id), { ...c, detectedAt: FieldValue.serverTimestamp() });
      }
      await batch.commit();
    }
    await areaRef.set(
      { s: area.s, w: area.w, n: area.n, e: area.e, lastCheckedAt: FieldValue.serverTimestamp(), ...osmUpdate },
      { merge: true },
    );
    log(`  ${area.id}: ${fresh.length} new changes`);
  }
}

(args['dry-run'] ? dryRun : run)().catch((e) => {
  console.error(e);
  process.exit(1);
});
