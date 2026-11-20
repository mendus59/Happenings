import { renderPage } from './browser.js';
import { extractFromPage, findEventPageLinks, siteNameFrom } from './extract/index.js';
import { normalizeEvent, dedupe, DEFAULT_TZ } from './normalize.js';
import { detectClosure } from './closure.js';

const PAST_GRACE_MS = 6 * 3600e3;
const FUTURE_LIMIT_MS = 365 * 864e5;

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/**
 * Scrape one venue URL. Follows up to 3 likely "events" links when the page itself has none
 * (so people can paste a homepage).
 * Returns { name, eventsPageUrl, events, methods }.
 */
export async function scrapeVenue(browser, url, { venueId, log = console.log, now = new Date() }) {
  const tried = [];
  let page = await renderPage(browser, url);
  const name0 = siteNameFrom(page.html, url);
  const ctx = { url: page.url, html: page.html, frames: page.frames, tz: DEFAULT_TZ, log };
  let { raw, methods } = await extractFromPage(ctx);
  tried.push(page.url);
  let eventsPageUrl = page.url;

  // Heuristic-only results on a homepage are weak; look for a real events page too.
  const weak = raw.length === 0 || Object.keys(methods).every((m) => m === 'heuristic' || m === 'captions');
  if (weak) {
    for (const link of findEventPageLinks(page.html, page.url)) {
      log(`  following likely events link: ${link}`);
      try {
        const p2 = await renderPage(browser, link);
        const ctx2 = { url: p2.url, html: p2.html, frames: p2.frames, tz: DEFAULT_TZ, log };
        const r2 = await extractFromPage(ctx2);
        tried.push(p2.url);
        const strong = Object.keys(r2.methods).some((m) => m !== 'heuristic' && m !== 'captions');
        if (r2.raw.length && (strong || raw.length === 0)) {
          raw = r2.raw;
          methods = r2.methods;
          eventsPageUrl = p2.url;
          ctx.venueTz = ctx2.venueTz || ctx.venueTz;
          if (strong) break;
        }
      } catch (e) {
        log(`  could not load ${link}: ${e.message}`);
      }
    }
  }

  const tz = ctx.venueTz || DEFAULT_TZ;
  const organizer = mostCommon(raw.map((r) => r.organizer));
  const name = /og:site_name/.test(page.html) ? name0 : organizer || name0;
  const nowMs = now.getTime();
  const events = dedupe(
    raw
      .map((r) => normalizeEvent(r, { venueId, venueName: name, baseUrl: eventsPageUrl, tz }))
      .filter(Boolean)
      .filter((e) => (e.end || e.start).getTime() >= nowMs - PAST_GRACE_MS && e.start.getTime() <= nowMs + FUTURE_LIMIT_MS),
  );
  const closure = detectClosure(page.html);
  return { name, eventsPageUrl, events, methods, tried, closure };
}
