// Acuity Scheduling (used by many Squarespace sites for classes, tours and workshops).
// Only "class" appointment types are real events with fixed dates; 1:1 booking slots are skipped.
import * as cheerio from 'cheerio';
import { fetchText, fetchJson } from '../net.js';

const BASE = 'https://app.acuityscheduling.com';
const MONTHS_AHEAD = 4;

export function findAcuityOwners(html, frameUrls = []) {
  const $ = cheerio.load(html);
  const owners = new Set();
  const urls = [
    ...frameUrls,
    ...$('iframe[src]').map((_, el) => $(el).attr('src')).get(),
    ...$('a[href]').map((_, el) => $(el).attr('href')).get(),
  ];
  for (const raw of urls) {
    try {
      const u = new URL(raw, 'https://x.invalid');
      if (!/(^|\.)acuityscheduling\.com$/.test(u.hostname)) continue;
      const owner = u.searchParams.get('owner');
      if (owner && /^\d+$/.test(owner)) owners.add(owner);
    } catch {
      /* ignore */
    }
  }
  // Embed scripts sometimes carry the owner id in a data attribute or inline JS.
  for (const m of html.matchAll(/acuityscheduling\.com\/schedule\.php\?owner=(\d+)/g)) owners.add(m[1]);
  return [...owners].slice(0, 3);
}

export function parseBusiness(schedulePageHtml) {
  const m = schedulePageHtml.match(/var BUSINESS = (\{.*?\});\s*\n/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Pure: build raw events from a parsed BUSINESS object plus availability lookups. */
export function classEventsFromAvailability(business, appointmentType, times, scheduleUrl) {
  const out = [];
  const cal = Object.values(business.calendars || {}).flat()[0];
  for (const slot of times) {
    const start = slot.time;
    const end = new Date(new Date(start).getTime() + (appointmentType.duration || 60) * 60000);
    out.push({
      title: appointmentType.name,
      start,
      end,
      description: appointmentType.description,
      url: `${scheduleUrl}&appointmentType=${appointmentType.id}`,
      image: appointmentType.image,
      location: cal?.location || '',
      price: Number(appointmentType.price) > 0 && !business.hidePrice ? `$${appointmentType.price}` : '',
      sourceCategories: ['class', appointmentType.category].filter(Boolean),
      spotsLeft: slot.slotsAvailable,
      source: 'acuity',
    });
  }
  return out;
}

function monthStarts(now, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function extractAcuity(ctx) {
  const owners = findAcuityOwners(ctx.html, ctx.frames.map((f) => f.url));
  const out = [];
  for (const owner of owners) {
    const scheduleUrl = `${BASE}/schedule.php?owner=${owner}`;
    const business = parseBusiness(await fetchText(scheduleUrl));
    if (!business) {
      ctx.log(`  acuity: could not read business ${owner}`);
      continue;
    }
    ctx.venueTz ||= business.timezone;
    const tz = business.timezone || ctx.tz;
    const types = Object.values(business.appointmentTypes || {})
      .flat()
      .filter((t) => t.active && !t.private && t.type === 'class');
    for (const type of types) {
      for (const calendarId of type.calendarIDs?.length ? type.calendarIDs : ['']) {
        const q = new URLSearchParams({
          owner: business.ownerKey,
          appointmentTypeId: String(type.id),
          calendarId: String(calendarId),
          timezone: tz,
        });
        const dates = [];
        for (const month of monthStarts(new Date(), MONTHS_AHEAD)) {
          try {
            const days = await fetchJson(`${BASE}/api/scheduling/v1/availability/month?${q}&month=${month}`);
            dates.push(...Object.entries(days).filter(([, ok]) => ok).map(([d]) => d));
          } catch (e) {
            ctx.log(`  acuity month ${month} failed: ${e.message}`);
          }
        }
        const times = [];
        for (const date of [...new Set(dates)].slice(0, 60)) {
          try {
            const byDay = await fetchJson(`${BASE}/api/scheduling/v1/availability/times?${q}&startDate=${date}`);
            for (const [day, slots] of Object.entries(byDay)) if (day === date) times.push(...slots);
          } catch (e) {
            ctx.log(`  acuity times ${date} failed: ${e.message}`);
          }
        }
        out.push(...classEventsFromAvailability(business, type, times, scheduleUrl));
      }
    }
  }
  return out;
}
