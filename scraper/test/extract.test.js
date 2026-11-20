import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { extractJsonLd } from '../src/extract/jsonld.js';
import { extractHeuristic } from '../src/extract/heuristic.js';
import { findAcuityOwners, parseBusiness, classEventsFromAvailability } from '../src/extract/acuity.js';
import { findIcalFeeds, eventsFromIcs } from '../src/extract/ical.js';
import { findEventPageLinks } from '../src/extract/index.js';
import { normalizeEvent, dedupe } from '../src/normalize.js';
import { categorize } from '../src/categorize.js';
import { diffEvents } from '../src/sync.js';

const finnriver = readFileSync(new URL('./fixtures/finnriver.rendered.html', import.meta.url), 'utf8');
const TZ = 'America/Los_Angeles';
const ctx = { venueId: 'v_test', venueName: 'Finnriver', baseUrl: 'https://www.finnriver.com/farm-music-event-calendar', tz: TZ };

test('Finnriver: JSON-LD from the rendered calendar widget', () => {
  const raw = extractJsonLd(finnriver);
  assert.ok(raw.length >= 40, `expected many events, got ${raw.length}`);
  const events = dedupe(raw.map((r) => normalizeEvent(r, ctx)).filter(Boolean));
  const comedy = events.find((e) => e.title === 'Comedy Show by Next Stop Comedy');
  assert.ok(comedy);
  assert.equal(comedy.start.toISOString(), '2026-11-21T02:00:00.000Z'); // 6pm PST
  assert.equal(comedy.category, 'comedy');
  assert.equal(comedy.price, 'Free');
  assert.match(comedy.url, /mycityscene\.com/);

  const closed = events.find((e) => /Closed/.test(e.title));
  assert.equal(closed.category, 'notice');
  assert.equal(closed.allDay, true);

  const byTitle = (t) => events.find((e) => e.title.startsWith(t))?.category;
  assert.equal(byTitle('Marine Science Trivia'), 'trivia');
  assert.equal(byTitle('Jack Dwyer'), 'music');
  assert.equal(byTitle('Tasting Tours'), 'food');
  assert.equal(byTitle('Swing Dance'), 'dance');
  assert.equal(byTitle('Dragonheart Wreath Making Workshop'), 'workshop');
  assert.equal(byTitle('Harvest Craft Fair'), 'market');

  // Recurring "Tasting Tours" on different days are separate events.
  assert.ok(events.filter((e) => e.title === 'Tasting Tours').length > 3);
});

test('heuristic extraction finds events when structured data is missing', () => {
  const $ = cheerio.load(finnriver);
  $('script[type="application/ld+json"]').remove();
  const raw = extractHeuristic($.html(), { tz: TZ, baseUrl: ctx.baseUrl, now: new Date('2026-11-19T08:00:00Z') });
  const titles = raw.map((r) => r.title);
  assert.ok(titles.includes('Comedy Show by Next Stop Comedy'), titles.slice(0, 10).join(' | '));
  const comedy = raw.find((r) => r.title === 'Comedy Show by Next Stop Comedy');
  assert.equal(comedy.start.toISOString(), '2026-11-21T02:00:00.000Z');
});

test('Acuity: finds the owner from an embed and builds class events', () => {
  const html = '<iframe src="https://app.acuityscheduling.com/schedule.php?owner=33323067&ref=sched_block"></iframe>';
  assert.deepEqual(findAcuityOwners(html), ['33323067']);
  const page = `<script>\n var BUSINESS = {"id":33323067,"ownerKey":"5b746bfa","name":"Mushroom Wonderland","timezone":"America/Los_Angeles","calendars":{"":[{"id":10720623,"location":""}]},"appointmentTypes":{"":[{"id":68174096,"name":"Guided Wild Mushroom Educational Workshop / Foray","active":true,"private":false,"type":"class","duration":150,"price":"115.00","description":"Learn about fungi","calendarIDs":[10720623]}]}};\n</script>`;
  const business = parseBusiness(page);
  assert.equal(business.ownerKey, '5b746bfa');
  const type = business.appointmentTypes[''][0];
  const raw = classEventsFromAvailability(business, type, [{ time: '2026-11-23T13:00:00-0800', slotsAvailable: 2 }], 'https://app.acuityscheduling.com/schedule.php?owner=33323067');
  const [ev] = raw.map((r) => normalizeEvent(r, { ...ctx, venueId: 'v_mw' }));
  assert.equal(ev.start.toISOString(), '2026-11-23T21:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-11-23T23:30:00.000Z');
  assert.equal(ev.price, '$115.00');
  assert.equal(ev.category, 'workshop');
});

test('iCal: Google Calendar embeds and recurring events', () => {
  const feeds = findIcalFeeds('<iframe src="https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=America%2FLos_Angeles"></iframe>', 'https://x.com');
  assert.deepEqual(feeds, ['https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics']);
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:1',
    'SUMMARY:Open Mic Night',
    'DTSTART;TZID=America/Los_Angeles:20261120T190000',
    'DTEND;TZID=America/Los_Angeles:20261120T210000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:2',
    'SUMMARY:Holiday Market',
    'DTSTART;VALUE=DATE:20261205',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const raw = eventsFromIcs(ics, { now: new Date('2026-11-19T00:00:00Z') });
  const evs = raw.map((r) => normalizeEvent(r, ctx));
  const mics = evs.filter((e) => e.title === 'Open Mic Night');
  assert.equal(mics.length, 3);
  assert.equal(mics[0].start.toISOString(), '2026-11-21T03:00:00.000Z');
  const market = evs.find((e) => e.title === 'Holiday Market');
  assert.equal(market.allDay, true);
  assert.equal(market.category, 'market');
});

test('finds likely events pages from a homepage', () => {
  const html = `<a href="/guided-mushroom-tour">Mushroom Foraging Tours</a><a href="/swag">Shop</a><a href="/events">Events</a><a href="https://other.com/events">x</a>`;
  const links = findEventPageLinks(html, 'https://www.mushroom-wonderland.com/');
  assert.deepEqual(links.sort(), ['https://www.mushroom-wonderland.com/events', 'https://www.mushroom-wonderland.com/guided-mushroom-tour']);
});

test('categorize falls back to description and to "other"', () => {
  assert.equal(categorize({ title: 'Saturday Night', description: 'Live bluegrass band on the patio' }).category, 'music');
  assert.equal(categorize({ title: 'Something', description: '' }).category, 'other');
});

test('sync diff: new, changed, removed, purged', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  const mk = (id, start, extra = {}) => ({ id, title: id, start: new Date(start), end: null, allDay: false, category: 'other', tags: ['other'], ...extra });
  const existing = new Map([
    ['keep', mk('keep', '2026-11-25T00:00:00Z')],
    ['change', mk('change', '2026-11-26T00:00:00Z')],
    ['gone', mk('gone', '2026-11-27T00:00:00Z')],
    ['past', mk('past', '2026-11-18T00:00:00Z')],
    ['ancient', mk('ancient', '2026-09-01T00:00:00Z')],
    ['revived', mk('revived', '2026-11-28T00:00:00Z', { removed: true })],
  ]);
  const scraped = [
    mk('keep', '2026-11-25T00:00:00Z'),
    mk('change', '2026-11-26T00:00:00Z', { description: 'now with details' }),
    mk('revived', '2026-11-28T00:00:00Z'),
    mk('new', '2026-12-01T00:00:00Z'),
  ];
  const d = diffEvents(existing, scraped, { now, allowRemovals: true });
  assert.deepEqual(d.creates.map((e) => e.id), ['new']);
  assert.deepEqual(d.updates.map((u) => u.id).sort(), ['change', 'revived']);
  assert.deepEqual(d.removes, ['gone']);
  assert.deepEqual(d.purges, ['ancient']);
  const safe = diffEvents(existing, [], { now, allowRemovals: false });
  assert.deepEqual(safe.removes, []);
});

test('every scraper category has display info in the web app', async () => {
  const { CATEGORIES } = await import('../src/categorize.js');
  const { CATEGORY_INFO } = await import('../../shared/categories.js');
  for (const c of CATEGORIES) assert.ok(CATEGORY_INFO[c.id], c.id);
  assert.ok(CATEGORY_INFO.other);
});

test('captions: Instagram feed posts (Bushel & Barrel)', async () => {
  const { extractCaptions, parseTimes } = await import('../src/extract/captions.js');
  const html = readFileSync(new URL('./fixtures/bushel-barrel.rendered.html', import.meta.url), 'utf8');
  const baseUrl = 'https://bushelandbarrelciderhouse.com/calendar-events-poulsbo-wa';
  const raw = extractCaptions(html, { tz: TZ, now: new Date('2026-11-20T21:00:00Z'), baseUrl });
  const evs = raw.map((r) => normalizeEvent(r, { ...ctx, baseUrl }));
  const find = (t) => evs.find((e) => e.title === t);

  const irish = evs.filter((e) => e.title === 'Irish Music Circle');
  assert.equal(irish.length, 2); // Nov 15 and Nov 22, each announced once
  assert.equal(find('Globe Tilt Trivia').category, 'trivia');
  const paint = find('Chainsaw Carved Mushroom Paint with Jess Ensslen!');
  assert.equal(paint.start.toISOString(), '2026-11-28T22:00:00.000Z'); // 2 PM PST
  assert.equal(paint.end.toISOString(), '2026-11-29T00:00:00.000Z');
  assert.match(paint.url, /instagram\.com\/p\//);
  // Announced in two posts with different wording, kept once.
  assert.equal(evs.filter((e) => e.start.toISOString() === '2026-11-14T02:00:00.000Z').length, 1);
  // "Purchase tickets by November 10th, ..." is a sentence, not an event.
  assert.ok(!evs.some((e) => /purchase/i.test(e.title)));
  // "Friday Hours: 4–9 PM" is opening hours, not an event.
  assert.ok(!evs.some((e) => /hours/i.test(e.title)));

  assert.deepEqual(parseTimes('NOON–9 PM').start, { h: 12, m: 0, mer: 'pm' });
  assert.equal(parseTimes('Irish Music 1-4pm').start.h, 13);
  assert.equal(parseTimes('11–2 PM').start.h, 11);
});
