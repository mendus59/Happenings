// Last-resort extraction for pages with no structured data: look for compact
// blocks that contain both a recognizable date and a title-like line.
import * as cheerio from 'cheerio';
import * as chrono from 'chrono-node';
import { zonedTimeToDate } from '../time.js';

const BLOCK_SELECTOR = [
  'article',
  'li',
  'tr',
  '[class*="event" i]',
  '[class*="Event"]',
  '[class*="listing" i]',
  '[class*="card" i]',
  '[class*="summary-item"]',
  '[class*="item" i]',
].join(',');

const TITLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i],strong,b,a';

function componentsToDate(c, tz) {
  const y = c.get('year');
  const mo = c.get('month');
  const d = c.get('day');
  const h = c.isCertain('hour') ? c.get('hour') : 0;
  const mi = c.isCertain('minute') ? c.get('minute') : 0;
  if (c.isCertain('timezoneOffset')) {
    const off = c.get('timezoneOffset');
    return new Date(Date.UTC(y, mo - 1, d, h, mi) - off * 60000);
  }
  return zonedTimeToDate(y, mo, d, h, mi, 0, tz);
}

export function extractHeuristic(html, { tz, now = new Date(), baseUrl } = {}) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,nav,header,footer,form').remove();
  const blocks = $(BLOCK_SELECTOR).toArray();
  // Deepest first so we pick the tightest block around each event.
  const depth = (el) => $(el).parents().length;
  blocks.sort((a, b) => depth(b) - depth(a));

  const consumed = new Set();
  const out = [];
  for (const el of blocks) {
    if (consumed.has(el)) continue;
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 8 || text.length > 700) continue;
    const results = chrono.parse(text, { instant: now, timezone: undefined }, { forwardDate: true });
    const r = results.find((x) => x.start.isCertain('day') && x.start.isCertain('month'));
    if (!r) continue;

    let title = '';
    $el.find(TITLE_SELECTOR).each((_, t) => {
      if (title) return;
      const candidate = $(t).text().replace(/\s+/g, ' ').trim();
      if (candidate.length >= 4 && candidate.length <= 160 && !candidate.includes(r.text) && /[a-z]{3}/i.test(candidate)) {
        title = candidate;
      }
    });
    if (!title) {
      const rest = text.replace(r.text, ' ').replace(/\s+/g, ' ').trim();
      const firstLine = rest.split(/\s[|•·–-]\s|\.\s/)[0].trim();
      if (firstLine.length >= 6 && firstLine.length <= 120 && /[a-z]{3}\s+[a-z]{2,}/i.test(firstLine)) title = firstLine;
    }
    if (!title) continue;

    const start = componentsToDate(r.start, tz);
    const allDay = !r.start.isCertain('hour');
    const end = r.end ? componentsToDate(r.end, tz) : null;
    const link = $el.is('a[href]') ? $el.attr('href') : $el.find('a[href]').first().attr('href');

    out.push({
      title,
      start,
      end: end && end > start ? end : null,
      allDay,
      url: link ? new URL(link, baseUrl).toString() : baseUrl,
      image: $el.find('img[src]').first().attr('src'),
      description: text.length > title.length + r.text.length + 20 ? text : '',
      source: 'heuristic',
    });
    for (const p of $el.parents().toArray()) consumed.add(p);
    if (out.length >= 150) break;
  }
  return out;
}
