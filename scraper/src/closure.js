// Spot "we're closing" announcements on a venue's own website.
import * as cheerio from 'cheerio';

const PATTERNS = [
  /\b(?:we(?:'|’)?re|we are|we have|we've|has|have)\s+(?:now\s+)?(?:permanently\s+)?clos(?:ed|ing)\s+(?:our\s+doors\s+)?(?:permanently|for good)\b/i,
  /\bpermanently\s+closed\b/i,
  /\bclosing\s+(?:our\s+doors|permanently|for good)\b/i,
  /\b(?:final|last)\s+(?:day|night|weekend)\s+(?:of\s+(?:business|service)|open)\b/i,
  /\bclosed\s+for\s+good\b/i,
  /\b(?:after|with)\s+(?:\w+\s+){0,4}(?:years?|decades?)[^.]{0,80}\b(?:closing|close)\s+(?:our|the)\s+doors\b/i,
];

/** Returns a short snippet around a closure announcement, or null. */
export function detectClosure(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) {
      // Ignore "temporarily" / holiday closures.
      const around = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
      if (/temporar|holiday|thanksgiving|christmas|new year|for the (?:day|season|winter)|reopen/i.test(around)) continue;
      return around.trim().slice(0, 240);
    }
  }
  return null;
}
