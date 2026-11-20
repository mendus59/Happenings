import * as cheerio from 'cheerio';
import ical from 'node-ical';
import { fetchText } from '../net.js';

const HORIZON_DAYS = 180;

/** Find iCalendar feeds linked or embedded on a page (including Google Calendar embeds). */
export function findIcalFeeds(html, baseUrl, frameUrls = []) {
  const $ = cheerio.load(html);
  const feeds = new Set();
  const add = (href) => {
    if (!href) return;
    try {
      const u = new URL(href.replace(/^webcals?:\/\//i, 'https://'), baseUrl);
      feeds.add(u.toString());
    } catch {
      /* ignore */
    }
  };
  $('link[type="text/calendar"]').each((_, el) => add($(el).attr('href')));
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (/^webcals?:\/\//i.test(href) || /\.ics(\?|$)/i.test(href) || /[?&](ical|outlook-ical)=1/i.test(href)) add(href);
  });
  const srcs = [...frameUrls, ...$('iframe[src]').map((_, el) => $(el).attr('src')).get()];
  for (const src of srcs) {
    for (const id of googleCalendarIds(src)) {
      feeds.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`);
    }
  }
  return [...feeds].slice(0, 5);
}

export function googleCalendarIds(src) {
  try {
    const u = new URL(src, 'https://x.invalid');
    if (!/(^|\.)calendar\.google\.com$/.test(u.hostname) || !u.pathname.includes('/calendar/embed')) return [];
    return u.searchParams.getAll('src').filter(Boolean);
  } catch {
    return [];
  }
}

function toRawDate(d) {
  if (!d) return null;
  if (d.dateOnly) {
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return ymd;
  }
  return new Date(d.getTime());
}

export function eventsFromIcs(text, { now = new Date() } = {}) {
  const data = ical.sync.parseICS(text);
  const until = new Date(now.getTime() + HORIZON_DAYS * 864e5);
  const from = new Date(now.getTime() - 864e5);
  const out = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    const base = {
      title: typeof ev.summary === 'object' ? ev.summary.val : ev.summary,
      description: typeof ev.description === 'object' ? ev.description.val : ev.description,
      location: typeof ev.location === 'object' ? ev.location.val : ev.location,
      url: typeof ev.url === 'object' ? ev.url.val : ev.url,
      sourceCategories: [].concat(ev.categories || []),
      source: 'ical',
    };
    const durationMs = ev.end ? ev.end - ev.start : 0;
    if (ev.rrule) {
      const exdates = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString().slice(0, 10)));
      for (const occ of ev.rrule.between(from, until, true).slice(0, 200)) {
        const key = occ.toISOString().slice(0, 10);
        if (exdates.has(key)) continue;
        const override = ev.recurrences?.[key];
        if (override) {
          out.push({ ...base, title: override.summary || base.title, start: toRawDate(override.start), end: toRawDate(override.end) });
          continue;
        }
        if (ev.start.dateOnly) {
          const d = new Date(occ);
          d.dateOnly = true;
          out.push({ ...base, start: toRawDate(d), allDay: true });
        } else {
          out.push({ ...base, start: new Date(occ), end: durationMs ? new Date(occ.getTime() + durationMs) : null });
        }
      }
    } else {
      out.push({ ...base, start: toRawDate(ev.start), end: ev.start.dateOnly ? null : toRawDate(ev.end), allDay: !!ev.start.dateOnly });
    }
  }
  return out;
}

export async function extractIcal(ctx) {
  const feeds = findIcalFeeds(ctx.html, ctx.url, ctx.frames.map((f) => f.url));
  const out = [];
  for (const feed of feeds) {
    try {
      out.push(...eventsFromIcs(await fetchText(feed, { accept: 'text/calendar' })));
    } catch (e) {
      ctx.log(`  ical feed failed (${feed}): ${e.message}`);
    }
  }
  return out;
}
