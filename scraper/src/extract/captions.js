// Events announced in social-media style posts, e.g. an Instagram feed widget whose
// captions are only in <img alt="..."> text:
//
//   🎶 FRIDAY, NOVEMBER 20 | 4–9 PM            <- day heading
//   🎻 Irish Music Circle | 1–4 PM             <- event on that day
//   📅 Saturday, November 28, 2026 / ⏰ 2–4 PM  <- single-event post, titled by its first line
import * as cheerio from 'cheerio';
import { zonedTimeToDate } from '../time.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_RE =
  /(?:\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i;
const T = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)`;
const RANGE_RE = new RegExp(String.raw`\b(${T})\s*(?:[–—-]|to)\s*(${T})`, 'i');
const SINGLE_RE = /\b(noon|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))(?![a-z])/i;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;
const GENERIC_LINE = /^(?:[a-z]+day\s+)?(?:store\s+|tasting room\s+)?hours?$|^(?:food|eats?)$/i;

const stripEmoji = (s) => s.replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();

function parseClock(s, fallbackMeridiem) {
  const t = s.toLowerCase().replace(/\./g, '').trim();
  if (t === 'noon') return { h: 12, m: 0, mer: 'pm' };
  if (t === 'midnight') return { h: 0, m: 0, mer: 'am' };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  const mer = m[3] || fallbackMeridiem;
  if (!mer) return null;
  let h = Number(m[1]) % 12;
  if (mer === 'pm') h += 12;
  return { h, m: Number(m[2] || 0), mer };
}

/** "1–4 PM", "NOON–9 PM", "2:00–4:00 PM", "6 pm" -> {start:{h,m}, end?:{h,m}, text} */
export function parseTimes(line) {
  const r = line.match(RANGE_RE);
  if (r) {
    const end = parseClock(r[2]);
    if (end) {
      let start = parseClock(r[1], end.mer);
      // "11–2 PM" means 11 AM; "6–8 PM" means 6 PM.
      if (start && !/[ap]\.?m|noon|midnight/i.test(r[1]) && start.h > end.h) start = parseClock(r[1], 'am');
      if (start) return { start, end, text: r[0] };
    }
  }
  const s = line.match(SINGLE_RE);
  if (s) {
    const start = parseClock(s[1]);
    if (start) return { start, end: null, text: s[0] };
  }
  return null;
}

export function parseDay(line, now) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  const day = Number(m[2]);
  if (!month || day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3]) : null;
  if (!year) {
    // Posts don't say the year: pick the one that puts the date closest to today.
    const y0 = now.getUTCFullYear();
    year = [y0 - 1, y0, y0 + 1].sort(
      (a, b) => Math.abs(Date.UTC(a, month - 1, day) - now) - Math.abs(Date.UTC(b, month - 1, day) - now),
    )[0];
  }
  return { y: year, mo: month, d: day, text: m[0] };
}

function tidyTitle(s) {
  let t = s
    .replace(/\s*[|•·]\s*/g, ' ')
    .replace(/\s+[–—-]\s*$/, '')
    .replace(/^[\s:–—-]+|[\s:,–—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // SHOUTY CAPS -> Title Case (keep short acronyms like BBQ, DJ).
  t = t.replace(/\b[A-Z][A-Z']{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
  return t;
}

function firstSentence(s) {
  const m = s.match(/^(.{8,80}?[.!?])(\s|$)/);
  if (m) return m[1].trim();
  return s.length <= 80 ? s : s.slice(0, 80).replace(/\s+\S*$/, '') + '…';
}
const hasWords = (s) => /[a-z]{3,}.*\s.*[a-z]{2,}|[a-z]{4,}/i.test(s);

/** Parse one caption into raw events. */
export function eventsFromCaption(text, { tz, now = new Date(), url, baseUrl }) {
  const lines = text.split(/\n/).map((l) => stripEmoji(l));
  const nonEmpty = lines.filter(Boolean);
  if (!nonEmpty.length) return [];
  const headline = tidyTitle(nonEmpty[0]);
  // Date lines short enough to be headings (long ones are sentences like "buy tickets by Nov 10").
  const isHeading = (l) => l.length <= 60 && DATE_RE.test(l);
  const dayCount = lines.filter(isHeading).length;
  const description = stripEmoji(text).slice(0, 1500);
  const out = [];
  let cur = null; // { day, time, idx, count }

  const at = (day, clock) => zonedTimeToDate(day.y, day.mo, day.d, clock.h, clock.m, 0, tz);
  const push = (day, time, title) => {
    if (!title || title.length < 3) return;
    const ev = { title, description, url: url || baseUrl, source: 'captions' };
    if (time) {
      ev.start = at(day, time.start);
      if (time.end) {
        let end = at(day, time.end);
        if (end <= ev.start) end = new Date(end.getTime() + 864e5);
        ev.end = end;
      }
    } else {
      ev.start = `${day.y}-${String(day.mo).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
      ev.allDay = true;
    }
    out.push(ev);
    if (cur) cur.count++;
  };

  const flush = () => {
    if (!cur || cur.count > 0) return;
    // A day heading with no listed sub-events: the post is about one thing that day.
    let title = '';
    if (dayCount === 1 || /^(?:event details|when)$/i.test(cur.rest)) title = headline;
    else {
      const next = lines
        .slice(cur.idx + 1)
        .find((l) => l && !isHeading(l) && hasWords(l.replace(parseTimes(l)?.text || '\u0000', '')));
      title = next ? tidyTitle(firstSentence(next)) : headline;
    }
    // A time on the next line belongs to this heading ("📅 Nov 28" then "⏰ 2–4 PM").
    let time = cur.time;
    if (!time) {
      const nextLine = lines.slice(cur.idx + 1).find(Boolean) || '';
      const t = parseTimes(nextLine);
      if (t && !hasWords(nextLine.replace(t.text, ''))) time = t;
    }
    push(cur.day, time, title);
  };

  lines.forEach((line, idx) => {
    if (!line) return;
    const day = isHeading(line) ? parseDay(line, now) : null;
    const time = parseTimes(day ? line.replace(day.text, ' ') : line);
    if (day) {
      flush();
      const rest = tidyTitle(
        line
          .replace(day.text, ' ')
          .replace(time?.text || '\u0000', ' ')
          .replace(/\b(?:at|on|from|tomorrow|today|tonight)\b/gi, ' ')
          .replace(/[!?.]+/g, ' '),
      );
      cur = { day, time, idx, count: 0, rest };
      if (hasWords(rest) && rest.length <= 100 && !/^(?:event details|when|date)$/i.test(rest)) push(day, time, rest);
      return;
    }
    if (cur && time) {
      const title = tidyTitle(line.replace(time.text, ' '));
      if (!title) return; // bare time line, handled by flush()
      if (GENERIC_LINE.test(title) || title.length > 80 || !hasWords(title)) return;
      // In a post about one event, "Live Music: 6–8 PM" is better titled by the post's headline.
      push(cur.day, time, dayCount === 1 && title.split(/\s+/).length <= 2 ? headline : title);
    }
  });
  flush();
  return out;
}

/** Find caption-like text (long image alt text, post caption elements) on a page. */
export function extractCaptions(html, { tz, now = new Date(), baseUrl } = {}) {
  const $ = cheerio.load(html);
  const captions = [];
  $('img[alt]').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    if (alt.length >= 80 && DATE_RE.test(alt)) {
      captions.push({ text: alt, url: $(el).closest('a[href]').attr('href') });
    }
  });
  $('[class*="caption" i], [class*="post-text" i], [class*="post_text" i]').each((_, el) => {
    const text = $(el).text();
    if (text.length >= 80 && DATE_RE.test(text)) captions.push({ text, url: $(el).closest('a[href]').attr('href') });
  });

  const out = [];
  const seenStarts = new Set();
  for (const c of captions) {
    let url = baseUrl;
    try {
      if (c.url) url = new URL(c.url, baseUrl).toString();
    } catch {
      /* keep base */
    }
    for (const ev of eventsFromCaption(c.text, { tz, now, url, baseUrl })) {
      // The same event is often announced in several posts with different wording.
      const key = String(ev.start instanceof Date ? ev.start.getTime() : ev.start);
      if (seenStarts.has(key)) continue;
      seenStarts.add(key);
      out.push(ev);
    }
  }
  return out;
}
