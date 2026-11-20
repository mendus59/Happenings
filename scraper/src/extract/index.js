import * as cheerio from 'cheerio';
import { extractJsonLd } from './jsonld.js';
import { extractMicrodata } from './microdata.js';
import { extractIcal } from './ical.js';
import { extractAcuity } from './acuity.js';
import { extractSquarespace, extractTribe } from './platforms.js';
import { extractHeuristic } from './heuristic.js';
import { extractCaptions } from './captions.js';

const REMOTE_EXTRACTORS = [
  ['ical', extractIcal],
  ['acuity', extractAcuity],
  ['squarespace', extractSquarespace],
  ['tribe', extractTribe],
];

/**
 * Run every extractor against a rendered page.
 * ctx: { url, html, frames: [{url, html}], tz, log }
 * Returns raw (un-normalized) events and per-method counts.
 */
export async function extractFromPage(ctx) {
  const raw = [];
  const methods = {};
  const add = (name, list) => {
    if (list?.length) {
      methods[name] = (methods[name] || 0) + list.length;
      raw.push(...list);
    }
  };
  const docs = [{ url: ctx.url, html: ctx.html }, ...ctx.frames.filter((f) => f.html)];
  for (const d of docs) {
    add('jsonld', extractJsonLd(d.html));
    add('microdata', extractMicrodata(d.html));
  }
  for (const [name, fn] of REMOTE_EXTRACTORS) {
    try {
      add(name, await fn(ctx));
    } catch (e) {
      ctx.log(`  ${name} failed: ${e.message}`);
    }
  }
  if (raw.length === 0) {
    for (const d of docs) add('captions', extractCaptions(d.html, { tz: ctx.tz, baseUrl: d.url }));
  }
  if (raw.length === 0) {
    for (const d of docs) add('heuristic', extractHeuristic(d.html, { tz: ctx.tz, baseUrl: d.url }));
  }
  return { raw: raw.filter((e) => !e.cancelled), methods };
}

const LINK_HINT =
  /\b(events?|calendar|schedule|shows?|concerts?|music|live|tours?|classes|workshops?|happenings|what'?s[- ]on|gigs|lineup|upcoming|forays?)\b/i;

/** Same-site links that look like they lead to an events page, best first. */
export function findEventPageLinks(html, baseUrl, limit = 3) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const site = base.hostname.replace(/^www\./, '');
  const scored = new Map();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (u.hostname.replace(/^www\./, '') !== site || !/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const key = u.toString();
    if (key === base.toString() || /\.(pdf|jpe?g|png|gif|zip)$/i.test(u.pathname) || /\/(cart|account|login|shop)\b/i.test(u.pathname)) return;
    const text = $(el).text().trim();
    let score = 0;
    if (LINK_HINT.test(u.pathname.replace(/[-_/]/g, ' '))) score += 2;
    if (LINK_HINT.test(text)) score += 2;
    if (/\bevents?\b|calendar/i.test(u.pathname + ' ' + text)) score += 1;
    if (score > 0) scored.set(key, Math.max(score, scored.get(key) || 0));
  });
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([u]) => u);
}

export function siteNameFrom(html, url) {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:site_name"]').attr('content');
  if (og?.trim()) return og.trim();
  const title = $('title').first().text().trim();
  if (title) {
    const parts = title.split(/\s+[|–—-]\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts[parts.length - 1];
    return parts[0];
  }
  return new URL(url).hostname.replace(/^www\./, '');
}
