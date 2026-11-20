#!/usr/bin/env node
// Happenings scraper. Runs on a schedule in GitHub Actions.
//
//   node scraper/src/index.js                      # sync every due venue to Firestore
//   node scraper/src/index.js --force              # ignore the schedule, rescan all venues
//   node scraper/src/index.js --dry-run --url URL  # print what would be found, no Firestore
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { normalizeVenueUrl, venueIdFor } from '../../shared/url.js';
import { launchBrowser } from './browser.js';
import { scrapeVenue } from './scrapeVenue.js';
import { diffEvents } from './sync.js';

const INTERVAL_HOURS = Number(process.env.SCRAPE_INTERVAL_HOURS || 6);
const MAX_VENUES_PER_RUN = Number(process.env.MAX_VENUES_PER_RUN || 60);

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    url: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
  },
});

const log = (...a) => console.log(...a);

async function dryRun(urls) {
  const browser = await launchBrowser();
  const report = [];
  let failures = 0;
  try {
    for (const input of urls) {
      const url = normalizeVenueUrl(input);
      const venueId = await venueIdFor(url);
      log(`\n=== ${url} (${venueId})`);
      try {
        const r = await scrapeVenue(browser, url, { venueId, log });
        log(`  name: ${r.name}\n  events page: ${r.eventsPageUrl}\n  methods: ${JSON.stringify(r.methods)}\n  events: ${r.events.length}`);
        for (const e of r.events) {
          log(`   - ${e.start.toISOString()} [${e.category}] ${e.title}${e.allDay ? ' (all day)' : ''}`);
        }
        if (!r.events.length) failures++;
        report.push({ url, ...r });
      } catch (e) {
        failures++;
        log(`  ERROR: ${e.stack || e.message}`);
        report.push({ url, error: e.message });
      }
    }
  } finally {
    await browser.close();
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  if (failures) process.exitCode = 1;
}

async function initFirestore() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set (add it as a GitHub Actions secret).');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  return getFirestore();
}

async function syncAll() {
  const db = await initFirestore();
  const { Timestamp, FieldValue } = await import('firebase-admin/firestore');
  const now = new Date();

  // 1. Collect every venue someone is subscribed to.
  const subs = await db.collectionGroup('subscriptions').get();
  const venues = new Map();
  for (const doc of subs.docs) {
    const url = normalizeVenueUrl(doc.get('url'));
    if (!url) continue;
    const id = await venueIdFor(url);
    const v = venues.get(id) || { id, url, subscribers: 0, scanRequestedAt: 0 };
    v.subscribers++;
    v.scanRequestedAt = Math.max(v.scanRequestedAt, doc.get('scanRequestedAt')?.toMillis?.() || 0);
    venues.set(id, v);
  }
  log(`${subs.size} subscriptions across ${venues.size} venues`);

  // 2. Work out which are due.
  const due = [];
  for (const v of venues.values()) {
    const snap = await db.doc(`venues/${v.id}`).get();
    const last = snap.get('lastScrapedAt')?.toMillis?.() || 0;
    v.prev = snap.exists ? snap.data() : null;
    v.last = last;
    if (args.force || !last || now - last >= INTERVAL_HOURS * 3600e3 || v.scanRequestedAt > last) due.push(v);
    else if (snap.get('subscriberCount') !== v.subscribers) {
      await snap.ref.set({ subscriberCount: v.subscribers }, { merge: true });
    }
  }
  due.sort((a, b) => a.last - b.last);
  const batchList = due.slice(0, MAX_VENUES_PER_RUN);
  log(`${due.length} venues due; scanning ${batchList.length}`);
  if (!batchList.length) return;

  // 3. Scrape and sync each.
  const browser = await launchBrowser();
  let errors = 0;
  try {
    for (const v of batchList) {
      log(`\n=== ${v.url} (${v.id})`);
      const venueRef = db.doc(`venues/${v.id}`);
      const base = { url: v.url, subscriberCount: v.subscribers, lastScrapedAt: Timestamp.fromDate(new Date()) };
      if (!v.prev) base.createdAt = FieldValue.serverTimestamp();
      let result;
      try {
        result = await scrapeVenue(browser, v.url, { venueId: v.id, log });
      } catch (e) {
        errors++;
        log(`  ERROR: ${e.message}`);
        await venueRef.set({ ...base, status: 'error', error: String(e.message).slice(0, 300) }, { merge: true });
        continue;
      }
      const evCol = venueRef.collection('events');
      const existingSnap = await evCol.get();
      const existing = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));
      const emptyStreak = result.events.length ? 0 : (v.prev?.emptyStreak || 0) + 1;
      // A single empty scrape may be a site hiccup; only treat events as removed when the
      // page still lists something, or it has been empty twice in a row.
      const allowRemovals = result.events.length > 0 || emptyStreak >= 2;
      const diff = diffEvents(existing, result.events, { now, allowRemovals });

      const ops = [];
      const serverNow = FieldValue.serverTimestamp();
      for (const ev of diff.creates) {
        const { id, ...data } = ev;
        ops.push((b) =>
          b.set(evCol.doc(id), {
            ...data,
            start: Timestamp.fromDate(data.start),
            end: data.end ? Timestamp.fromDate(data.end) : null,
            removed: false,
            removedAt: null,
            firstSeenAt: serverNow,
            updatedAt: serverNow,
          }),
        );
      }
      for (const { id, changed } of diff.updates) {
        const data = { ...changed, updatedAt: serverNow };
        if ('end' in data) data.end = data.end ? Timestamp.fromDate(data.end) : null;
        ops.push((b) => b.update(evCol.doc(id), data));
      }
      for (const id of diff.removes) ops.push((b) => b.update(evCol.doc(id), { removed: true, removedAt: serverNow, updatedAt: serverNow }));
      for (const id of diff.purges) ops.push((b) => b.delete(evCol.doc(id)));
      for (let i = 0; i < ops.length; i += 400) {
        const b = db.batch();
        ops.slice(i, i + 400).forEach((op) => op(b));
        await b.commit();
      }

      const upcoming = result.events.length;
      await venueRef.set(
        {
          ...base,
          name: result.name,
          eventsPageUrl: result.eventsPageUrl,
          status: upcoming ? 'ok' : 'empty',
          error: null,
          eventCount: upcoming,
          methods: result.methods,
          emptyStreak,
          lastSuccessAt: base.lastScrapedAt,
        },
        { merge: true },
      );
      log(
        `  ${upcoming} events via ${JSON.stringify(result.methods)} — +${diff.creates.length} new, ` +
          `${diff.updates.length} changed, ${diff.removes.length} removed, ${diff.purges.length} purged`,
      );
    }
  } finally {
    await browser.close();
  }
  if (errors) log(`\n${errors} venue(s) failed; they'll be retried next run.`);
}

const main = args['dry-run'] ? () => dryRun(args.url) : syncAll;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
