import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { parseDateString, hmInZone } from './time.js';
import { categorize } from './categorize.js';

export const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Los_Angeles';

/** Decode entities / strip tags / collapse whitespace. */
export function cleanText(s, max = 0) {
  if (s == null) return '';
  let t = String(s);
  if (/[<&]/.test(t)) {
    // Keep line breaks from block elements before stripping tags.
    t = t.replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n');
    t = cheerio.load(`<div>${t}</div>`)('div').first().text();
  }
  t = t.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

function absUrl(u, base) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function eventIdFor(venueId, title, start, allDay) {
  const t = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const when = allDay ? start.toISOString().slice(0, 10) : start.toISOString().slice(0, 16);
  return 'e_' + createHash('sha256').update(`${venueId}|${t}|${when}`).digest('hex').slice(0, 20);
}

/**
 * Turn a raw extracted event into the stored shape, or null if unusable.
 * raw: { title, start, end?, allDay?, description?, url?, image?, location?, price?, sourceCategories?, source }
 */
export function normalizeEvent(raw, { venueId, venueName, baseUrl, tz = DEFAULT_TZ }) {
  const title = cleanText(raw.title, 200);
  if (!title) return null;
  const s = raw.start instanceof Date ? { date: raw.start, dateOnly: !!raw.allDay } : parseDateString(raw.start, tz);
  if (!s || isNaN(s.date)) return null;
  let e = raw.end instanceof Date ? { date: raw.end } : raw.end ? parseDateString(raw.end, tz) : null;
  if (e && (isNaN(e.date) || e.date < s.date)) e = null;

  let allDay = !!(raw.allDay ?? s.dateOnly);
  // "12:00am - 11:59pm" style entries are really all-day.
  if (!allDay && e) {
    const a = hmInZone(s.date, tz);
    const b = hmInZone(e.date, tz);
    if (a.h === 0 && a.m === 0 && ((b.h === 23 && b.m >= 59) || (b.h === 0 && b.m === 0))) allDay = true;
  }

  const description = cleanText(raw.description, 1500);
  const { category, tags } = categorize({ title, description, sourceCategories: raw.sourceCategories });
  const ev = {
    id: eventIdFor(venueId, title, s.date, allDay),
    title,
    start: s.date,
    end: e ? e.date : null,
    allDay,
    tz,
    description,
    url: absUrl(raw.url, baseUrl) || baseUrl,
    image: absUrl(Array.isArray(raw.image) ? raw.image[0] : raw.image?.url || raw.image, baseUrl),
    location: cleanText(raw.location, 200),
    price: cleanText(raw.price, 60),
    category,
    tags,
    source: raw.source || 'unknown',
    venueId,
    venueName: venueName || '',
  };
  return ev;
}

/** Merge events from several extractors; first one wins, later ones fill blanks. */
export function dedupe(events) {
  const byId = new Map();
  for (const ev of events) {
    const prev = byId.get(ev.id);
    if (!prev) {
      byId.set(ev.id, ev);
      continue;
    }
    for (const k of ['end', 'description', 'image', 'location', 'price']) {
      if (!prev[k] && ev[k]) prev[k] = ev[k];
    }
  }
  return [...byId.values()].sort((a, b) => a.start - b.start);
}
