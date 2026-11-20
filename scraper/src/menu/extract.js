// Read a restaurant's menu from its own web page (or PDF text).
// Tries, in order: schema.org Menu JSON-LD, common menu-widget markup, then a line-by-line
// "Dish name ..... $14" reader that also handles PDFs.
import * as cheerio from 'cheerio';
import { serviceForUrl } from '../../../shared/restaurants.js';

export const MAX_ITEMS = 300;
const MIN_ITEMS = 5;

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s•·*\-–—|]+|[\s•·*\-–—|.]+$/g, '')
    .trim();

function toPrice(v) {
  if (v == null || v === '') return null;
  const m = String(v).replace(',', '.').match(/\d{1,3}(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0]);
  return n > 0 && n < 1000 ? n : null;
}

function item(name, price, desc, section) {
  const n = clean(name).slice(0, 90);
  if (!n || n.length < 2 || !/[a-z]/i.test(n)) return null;
  const out = { n };
  if (price != null) out.p = price;
  const d = clean(desc).slice(0, 160);
  if (d && d !== n) out.d = d;
  const s = clean(section).slice(0, 60);
  if (s) out.s = s;
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const i of items) {
    if (!i) continue;
    const k = `${i.s || ''}|${i.n.toLowerCase()}|${i.p ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---------- 1. schema.org JSON-LD ----------

function* walk(node) {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v);
  }
}

const types = (n) => [].concat(n?.['@type'] || []).map(String);
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function menuFromJsonLd($) {
  const items = [];
  const menuUrls = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    for (const n of walk(data)) {
      if (typeof n.hasMenu === 'string') menuUrls.push(n.hasMenu);
      if (n.hasMenu?.url && !n.hasMenu.hasMenuSection) menuUrls.push(n.hasMenu.url);
      if (!types(n).includes('Menu')) continue;
      const visit = (sec, name) => {
        for (const mi of arr(sec.hasMenuItem)) {
          const offer = arr(mi.offers)[0] || {};
          items.push(item(mi.name, toPrice(offer.price ?? mi.price), mi.description, name));
        }
        for (const sub of arr(sec.hasMenuSection)) visit(sub, sub.name || name);
      };
      visit(n, '');
    }
  });
  return { items: dedupe(items), menuUrls };
}

// ---------- 2. menu widgets (Squarespace, BentoBox, Popmenu, WordPress plugins, ...) ----------

const ITEM_SEL = [
  '.menu-item',
  '[class*="menu-item"]',
  '[class*="menuItem"]',
  '[class*="MenuItem"]',
  '[class*="food-item"]',
  '[class*="dish-item"]',
  '[data-testid*="menu-item"]',
  '.fdm-item',
  '.rm-item',
].join(',');
const PRICE_SEL = '[class*="price"],[class*="Price"]';
const TITLE_SEL = '[class*="title"],[class*="Title"],[class*="name"],[class*="Name"],h3,h4,h5,strong,b';
const DESC_SEL = '[class*="desc"],[class*="Desc"],p';
const SECTION_SEL = '[class*="section-title"],[class*="sectionTitle"],[class*="section-header"],[class*="category-title"],[class*="menu-section__title"],h2,h3';

export function menuFromWidgets($) {
  // Keep only the outermost matching item containers.
  // Item containers hold exactly one price; keep the outermost such container.
  const priceCount = (el) => ($(el).text().match(/\$\s?\d{1,3}(?:\.\d{2})?/g) || []).length || $(el).find(PRICE_SEL).length;
  const ones = new Set($(ITEM_SEL).toArray().filter((el) => priceCount(el) === 1));
  const nodes = [...ones].filter((el) => !$(el).parents().toArray().some((p) => ones.has(p)));
  const items = [];
  for (const el of nodes) {
    const $el = $(el);
    const priceText = $el.find(PRICE_SEL).first().text() || ($el.text().match(/\$\s?\d{1,3}(?:\.\d{2})?/) || [])[0] || '';
    const price = toPrice(priceText);
    const $title = $el.find(TITLE_SEL).not(PRICE_SEL).first();
    const name = $title.length ? $title.text() : $el.contents().first().text();
    const desc = $el.find(DESC_SEL).not(PRICE_SEL).not($title).first().text();
    // Nearest section heading before this item.
    let section = '';
    let cur = $el;
    for (let i = 0; i < 6 && cur.length && !section; i++) {
      const prev = cur.prevAll(SECTION_SEL).first();
      if (prev.length) section = prev.text();
      else {
        const inside = cur.parent().children(SECTION_SEL).first();
        if (inside.length && !inside.is(ITEM_SEL) && !inside.closest(ITEM_SEL).length) section = inside.text();
      }
      cur = cur.parent();
    }
    if (price == null && !desc) continue;
    items.push(item(name.replace(/\$\s?\d[\d.]*\s*$/, ''), price, desc, section));
  }
  return dedupe(items);
}

// ---------- 3. lines ----------

const BLOCK = 'p,div,li,dt,dd,tr,td,th,section,article,header,footer,h1,h2,h3,h4,h5,h6,br,table,ul,ol';

/** Visible text of a page as lines; headings are prefixed with "§ ". */
export function htmlToLines($) {
  const $c = cheerio.load($.html());
  $c('script,style,noscript,svg,iframe,template,nav,form,select,button').remove();
  $c('h1,h2,h3,h4,h5,h6').each((_, el) => {
    $c(el).prepend('\n§ ').append('\n');
  });
  $c(BLOCK).each((_, el) => {
    $c(el).before('\n').after('\n');
  });
  const text = ($c('main').length ? $c('main') : $c('body')).text();
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
}

const DOLLAR_PRICE = /\$\s?(\d{1,3}(?:[.,]\d{1,2})?)(?:\s*(?:\/|\||or)\s*\$?\s?\d{1,3}(?:[.,]\d{1,2})?)*\s*\+?(?:\s*\([^)]{0,40}\))?$/;
const BARE_PRICE = /(?:^|\s|\.{2,}|…|[–—-]\s)(\d{1,3}(?:[.,]\d{2})?)(?:\s*(?:\/|\|)\s*\d{1,3}(?:[.,]\d{2})?)*(?:\s*\([^)]{0,40}\))?\s*$/;
const NOT_DISH = /\b(?:am|pm|a\.m|p\.m|hours?|open|closed?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|suite|ste|street|st\.|ave|avenue|road|rd\.|hwy|wa|zip|phone|call|tel|fax|copyright|©|rights reserved|gift cards?|tax|gratuity|parties of|minimum|delivery fee|serves|ages?|years?|login|slot|togel)\b/i;
const ADDON = /^(?:\+|add\b|add-on|adds?\s|make it\b|sub(?:stitute)?\b|swap\b|extra\b|upgrade|choice of|choose|with\s|w\/|or\s)|\badd$/i;
const SIZE = /^(?:cup|bowl|small|sm|medium|med|large|lg|grande|half|full|regular|reg|single|double|triple|glass|bottle|carafe|pitcher|slice|whole|pint|\d+\s*(?:pc|pcs|piece|pieces|oz|in|inch|")\b)/i;
const PHONE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const MP = /\b(?:MP|market price|market)\s*$/i;

function priceAtEnd(line, allowBare) {
  if (PHONE.test(line)) return null;
  let m = line.match(DOLLAR_PRICE);
  if (!m && allowBare) m = line.match(BARE_PRICE);
  if (!m) {
    if (MP.test(line) && line.replace(MP, '').trim().length > 2) return { price: null, name: line.replace(MP, '').trim() };
    return null;
  }
  if (line[m.index] === '+' || line.slice(Math.max(0, m.index - 1), m.index + 1).includes('+')) return { addon: true, name: line };
  const name = line.slice(0, m.index).replace(/[.…\s–—-]+$/, '').trim();
  return { price: toPrice(m[1]), name };
}

const PRICE_ONLY = /^\$?\s?\d{1,3}(?:[.,]\d{1,2})?(?:\s*(?:\/|\|)\s*\$?\d{1,3}(?:[.,]\d{1,2})?)*\s*\+?$/;
const isPriceOnly = (line, allowBare) => (allowBare ? PRICE_ONLY.test(line) : PRICE_ONLY.test(line) && line.includes('$')) || (MP.test(line) && line.length < 14);

const isHeadingLike = (l) => l.startsWith('§ ') || (l.length <= 40 && l === l.toUpperCase() && /[A-Z]{3}/.test(l) && !/\d/.test(l));
const wordy = (s) => /[a-z]{3,}/i.test(s.replace(/\boz\b/gi, ''));
/** Looks like the tail of a description rather than a dish name. */
const descy = (s) => /^[a-z(]/.test(s) || s.length > 55 || (s.match(/,/g) || []).length >= 2 || /[,;]$/.test(s);
/** Looks like a dish name or a section title. */
const titley = (s) => s.length >= 2 && s.length <= 55 && /^[\p{Lu}0-9"“'(]/u.test(s) && !/[,;]$/.test(s) && (s.match(/,/g) || []).length < 2 && !NOT_DISH.test(s) && wordy(s);

/** Pure: read menu items out of lines of text (from a web page or a PDF). */
export function menuFromLines(lines) {
  const dollarEnd = lines.filter((l) => DOLLAR_PRICE.test(l) && !/\+\s?\$/.test(l)).length;
  const bareEnd = lines.filter((l) => !/\$/.test(l) && BARE_PRICE.test(l) && wordy(l)).length;
  // Menus that print "Pad Thai 14" with no dollar signs (dollar signs only on add-ons).
  const allowBare = bareEnd >= 3 && bareEnd >= dollarEnd * 0.5;
  const items = [];
  let section = '';
  let heading = null; // { text } — a heading not yet used as a dish name or a section
  let pending = null; // last item, which may still get (more) description
  let buf = []; // lines since the last item or heading, not yet used
  const push = (it) => {
    if (it) items.push(it);
    return it;
  };
  const useHeadingAsSection = () => {
    if (heading) section = heading.text;
    heading = null;
  };
  /** Name for a priced line whose own text is description: the heading, or the last title-like line. */
  const titleFor = () => {
    if (heading) return { name: heading.text, desc: buf, fromHeading: true };
    for (let k = buf.length - 1; k >= 0; k--) if (titley(buf[k]) && !descy(buf[k])) return { name: buf[k], desc: buf.slice(k + 1) };
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length > 300) {
      pending = null;
      buf = [];
      continue;
    }
    const line = raw.replace(/^§ ?/, '').trim();
    if (!line) continue;

    if (isPriceOnly(line, allowBare)) {
      // "Name" / "description" / "$14" layouts (menu widgets, PDFs).
      const cand = buf.filter((l) => !NOT_DISH.test(l.slice(0, 40)));
      const short = cand.filter((l) => l.length <= 70 && titley(l));
      if (short.length) {
        // "Name / description / $8": the name is the earlier of the last two lines.
        const name = cand.length >= 2 && titley(cand.at(-2)) && cand.at(-2).length <= 70 ? cand.at(-2) : short.at(-1);
        const desc = cand.slice(cand.indexOf(name) + 1).join(' ');
        useHeadingAsSection();
        pending = push(item(name, toPrice(line), desc, section));
      } else if (heading) {
        pending = push(item(heading.text, toPrice(line), cand.join(' '), section));
        heading = null;
      } else if (pending && pending.p == null) pending.p = toPrice(line);
      pending = null;
      buf = [];
      continue;
    }

    const hit = priceAtEnd(line, allowBare);
    if (hit?.addon || (hit && ADDON.test(hit.name))) {
      buf = [];
      continue; // "+ Add bacon $3", "Substitute shrimp Add 3.50"
    }
    if (hit && hit.name.length <= 160 && !NOT_DISH.test(hit.name.slice(0, 40)) && wordy(hit.name)) {
      const t = descy(hit.name) || SIZE.test(hit.name) || buf.some((l) => l.length > 60) ? titleFor() : null;
      if (t) {
        const size = SIZE.test(hit.name) ? hit.name : '';
        const name = size ? `${t.name} (${size})` : t.name;
        const desc = [...t.desc, size ? '' : hit.name].filter(Boolean).join(' ');
        if (t.fromHeading) heading = null;
        pending = push(item(name, hit.price, desc, section));
      } else {
        useHeadingAsSection();
        // "Name — description $14" on one line.
        const [n, ...rest] = hit.name.split(/\s+[–—-]\s+|\s*:\s+/);
        const split = rest.length && n.length <= 50;
        pending = push(item(split ? n : hit.name, hit.price, split ? rest.join(' - ') : '', section));
      }
      buf = [];
      continue;
    }

    const next = (lines[i + 1] || '').replace(/^§ ?/, '').trim();
    const nextHit = priceAtEnd(next, allowBare);
    const headingHere =
      (isHeadingLike(raw) && line.length <= 60 && !NOT_DISH.test(line)) ||
      // "Starters." followed directly by a priced dish line.
      // Not when the line could be the pending dish's description (e.g. "Marinated pork, pineapple").
      (!(pending && !pending.d) && !line.includes(',') &&
        line.length <= 32 && !/\d/.test(line) && line.split(/\s+/).length <= 4 && titley(line) && nextHit && !nextHit.addon && !descy(nextHit.name));
    if (headingHere) {
      // A heading straight after another unused heading means the first was a section title.
      if (heading && !buf.length) useHeadingAsSection();
      else if (heading && buf.length && buf.join(' ').length >= 30) push(item(heading.text, null, buf.join(' '), section));
      heading = { text: line.replace(/[.:]$/, '') };
      pending = null;
      buf = [];
      continue;
    }
    if (pending && line.length <= 220 && (pending.d || '').length < 150 && !NOT_DISH.test(line.slice(0, 30)) && (!pending.d || descy(line) || !titley(line))) {
      pending.d = clean(`${pending.d || ''} ${line}`).slice(0, 160);
      continue;
    }
    pending = null;
    buf.push(line);
    if (buf.length > 6) buf.shift();
  }
  const out = dedupe(items).filter((i) => wordy(i.n));
  if (out.filter((i) => i.p != null).length < MIN_ITEMS) return [];
  return looksLikeFood(out) ? out : [];
}

const FOOD = /\b(?:chicken|beef|pork|steak|burger|fries|salad|soup|sandwich|wrap|taco|burrito|pizza|pasta|noodle|rice|egg|eggs|bacon|cheese|sauce|bread|toast|fish|shrimp|salmon|tuna|crab|wings?|curry|roll|sushi|cake|pie|cookie|coffee|latte|espresso|tea|beer|wine|cocktail|margarita|ipa|dessert|chips|dip|nachos|quesadilla|enchilada|tamale|pho|ramen|dumpling|tofu|vegan|vegetarian|gf|potato|onion|tomato|garlic|lettuce|avocado|guacamole|salsa|bbq|grilled|fried|roasted|smoked|baked|served|topped|fresh|house|mushroom|spinach|pancake|waffle|biscuit|gravy|omelet|bagel|muffin|donut|croissant|scone|pastry|smoothie|juice|soda|lemonade|ice cream|sundae|shake|appetizers?|entrees?|sides?|kids|breakfast|lunch|dinner|brunch)\b/i;

/** Rejects spam pages and other price lists that aren't food. */
export function looksLikeFood(items) {
  const hits = items.filter((i) => FOOD.test(`${i.n} ${i.d || ''} ${i.s || ''}`)).length;
  return hits >= Math.max(3, items.length * 0.3);
}

// ---------- page-level helpers ----------

const MENU_TEXT = /^(?:our\s+|view\s+(?:our\s+)?|see\s+(?:our\s+)?|full\s+|food\s+|dinner\s+|lunch\s+|brunch\s+|breakfast\s+|drinks?\s+|happy hour\s+|take[- ]?out\s+|to[- ]go\s+)?(?:menus?|food|dinner|lunch|brunch|breakfast|eat|food\s*(?:&|and)\s*drinks?)(?:\s+menus?)?(?:\s*\(pdf\))?$/i;
const MENU_HREF = /menu|food|dinner|lunch|brunch|breakfast/i;
const SKIP_HREF = /facebook|instagram|twitter|yelp|tripadvisor|google\.|apple\.com|mailto:|tel:|#$/i;

/** Likely menu pages linked from a page (same site, PDFs, or menu hosts), best first. */
export function menuLinksFrom($, baseUrl) {
  const base = new URL(baseUrl);
  const scored = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (SKIP_HREF.test(href)) return;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const text = clean($(a).text() || $(a).attr('aria-label') || $(a).attr('title') || '');
    const sameSite = u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
    const pdf = /\.pdf($|\?)/i.test(u.pathname);
    const svc = serviceForUrl(u.href);
    let score = 0;
    if (MENU_TEXT.test(text)) score += 5;
    else if (/\bmenus?\b/i.test(text) && text.length <= 40) score += 3;
    if (MENU_HREF.test(u.pathname)) score += 2;
    if (pdf) score += 1;
    if (!sameSite && !pdf && !/popmenu|bentobox|singleplatform|menufy|toasttab|square\.site|spoton|clover/i.test(u.hostname)) score -= 4;
    if (svc && !/popmenu/.test(svc.id)) score -= 1; // ordering pages work as menus, but prefer the site's own
    if (u.href === base.href) score = 0;
    if (score >= 3) scored.set(u.href, Math.max(score, scored.get(u.href) || 0));
  });
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 4);
}

const ORDER_TEXT = /\border(?:ing)?\b.*\b(?:online|now|here|pick ?up|take ?out|to[- ]go|delivery)\b|\b(?:online|start (?:an )?)order(?:ing)?\b|^order$|^(?:pick ?up|take ?out|delivery)$|\bget (?:it )?delivered\b/i;

/** Ordering links on a restaurant's page: delivery apps and the restaurant's own online ordering. */
export function orderLinksFrom($, baseUrl) {
  const out = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    const svc = serviceForUrl(u.href);
    const text = clean($(a).text() || $(a).attr('aria-label') || '');
    if (svc) {
      if (!out.has(svc.id)) out.set(svc.id, { id: svc.id, label: svc.label, url: u.href, delivery: !!svc.delivery, takeout: !!svc.takeout });
    } else if (ORDER_TEXT.test(text) && text.length <= 40 && !SKIP_HREF.test(u.href)) {
      if (!out.has('direct')) out.set('direct', { id: 'direct', label: 'Order on their website', url: u.href, delivery: /deliver/i.test(text), takeout: true });
    }
  });
  return [...out.values()].slice(0, 8);
}

/** Services mentioned in the page text (sets true only; silence proves nothing). */
export function serviceHints(text) {
  return {
    delivery: /\b(?:we deliver|free delivery|delivery (?:available|now|is available)|order (?:for )?delivery|available for delivery)\b/i.test(text),
    takeout: /\b(?:take[- ]?out|to[- ]go orders?|order (?:for )?pick ?up|curbside|call (?:in|ahead))\b/i.test(text),
    dine: /\b(?:dine[- ]in|reservations?|book a table|our dining room)\b/i.test(text),
  };
}

/** Best menu found on one page's HTML. */
export function extractMenu(html, url) {
  const $ = cheerio.load(html);
  const ld = menuFromJsonLd($);
  const widgets = menuFromWidgets($);
  const lines = menuFromLines(htmlToLines($));
  const candidates = [
    { source: 'jsonld', items: ld.items },
    { source: 'widget', items: widgets },
    { source: 'text', items: lines },
  ].filter((c) => c.items.filter((i) => i.p != null).length >= MIN_ITEMS || (c.source === 'jsonld' && c.items.length >= MIN_ITEMS));
  // Structured sources win unless the text reader found far more.
  const best = candidates.sort((a, b) => score(b) - score(a))[0];
  return {
    items: best?.items || [],
    source: best?.source || '',
    menuUrls: ld.menuUrls.map((u) => {
      try {
        return new URL(u, url).href;
      } catch {
        return null;
      }
    }).filter(Boolean),
    links: menuLinksFrom($, url),
    orderLinks: orderLinksFrom($, url),
    hints: serviceHints($('body').text()),
  };
}

const score = (c) => c.items.length * (c.source === 'text' ? 1 : 1.5);
