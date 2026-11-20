// Fill the local Firebase emulators with demo data (Finnriver fixture events + a mushroom foray)
// so the app can be tried without touching production.
//   npm run emulators   (in one terminal)
//   npm run seed        (in another), then open http://localhost:5173/?emulator
//   sign in as demo@example.com / demo-password
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { extractJsonLd } from '../scraper/src/extract/jsonld.js';
import { classEventsFromAvailability } from '../scraper/src/extract/acuity.js';
import { normalizeEvent, dedupe } from '../scraper/src/normalize.js';
import { normalizeVenueUrl, venueIdFor } from '../shared/url.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
initializeApp({ projectId: 'happenings-79a0e' });
const db = getFirestore();
const auth = getAuth();

const email = 'demo@example.com';
let user;
try {
  user = await auth.getUserByEmail(email);
} catch {
  user = await auth.createUser({ email, password: 'demo-password', displayName: 'Demo User' });
}

async function putVenue(url, name, events) {
  const id = await venueIdFor(normalizeVenueUrl(url));
  await db.doc(`venues/${id}`).set({
    url,
    name,
    eventsPageUrl: url,
    status: 'ok',
    eventCount: events.length,
    lastScrapedAt: Timestamp.now(),
    subscriberCount: 1,
  });
  const batch = db.batch();
  for (const ev of events) {
    const { id: eid, ...data } = ev;
    batch.set(db.doc(`venues/${id}/events/${eid}`), {
      ...data,
      venueId: id,
      start: Timestamp.fromDate(data.start),
      end: data.end ? Timestamp.fromDate(data.end) : null,
      removed: false,
      firstSeenAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  await db.doc(`users/${user.uid}/subscriptions/${id}`).set({ url, label: '', addedAt: Timestamp.now(), scanRequestedAt: Timestamp.now() });
  return { id, events };
}

// Shift fixture dates so the demo always looks current.
const shiftDays = Math.max(0, Math.floor((Date.now() - Date.parse('2026-11-19T00:00:00Z')) / 864e5));
const shift = (e) => ({ ...e, start: new Date(e.start.getTime() + shiftDays * 864e5), end: e.end ? new Date(e.end.getTime() + shiftDays * 864e5) : null });

const finnUrl = 'https://www.finnriver.com/farm-music-event-calendar';
const finnId = await venueIdFor(normalizeVenueUrl(finnUrl));
const html = readFileSync(new URL('../scraper/test/fixtures/finnriver.rendered.html', import.meta.url), 'utf8');
const finn = dedupe(
  extractJsonLd(html)
    .map((r) => normalizeEvent(r, { venueId: finnId, venueName: 'Finnriver Farm & Cidery', baseUrl: finnUrl }))
    .filter(Boolean),
).map(shift);
const f = await putVenue(finnUrl, 'Finnriver Farm & Cidery', finn);

const mwUrl = 'https://www.mushroom-wonderland.com/';
const mwId = await venueIdFor(normalizeVenueUrl(mwUrl));
const business = { name: 'Mushroom Wonderland', calendars: { '': [{ id: 1, location: 'Kitsap County, WA' }] } };
const type = { id: 68174096, name: 'Guided Wild Mushroom Educational Workshop / Foray', duration: 150, price: '115.00', description: 'An educational foray into a 120 acre old growth preserve to learn about wild mushrooms.' };
const times = [4, 11].map((d) => ({ time: new Date(Date.now() + d * 864e5).toISOString().slice(0, 10) + 'T13:00:00-0800' }));
const mw = classEventsFromAvailability(business, type, times, 'https://app.acuityscheduling.com/schedule.php?owner=33323067')
  .map((r) => normalizeEvent(r, { venueId: mwId, venueName: 'Mushroom Wonderland', baseUrl: mwUrl }))
  .filter(Boolean);
await putVenue(mwUrl, 'Mushroom Wonderland', mw);

// A couple of pre-set review states so every state is visible.
const ids = f.events.map((e) => e.id);
await db.doc(`users/${user.uid}/reviews/${finnId}__${ids[1]}`).set({ state: 'favorite', venueId: finnId, eventId: ids[1] });
await db.doc(`users/${user.uid}/reviews/${finnId}__${ids[3]}`).set({ state: 'interested', venueId: finnId, eventId: ids[3] });
await db.doc(`users/${user.uid}/reviews/${finnId}__${ids[2]}`).set({ state: 'hidden', venueId: finnId, eventId: ids[2] });

console.log(`Seeded ${finn.length + mw.length} events for ${email} (password: demo-password)`);
process.exit(0);
