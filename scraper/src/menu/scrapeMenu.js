// Visit one restaurant's website: find its menu (page or PDF), ordering links and
// hints about takeout / delivery / dine-in.
import { renderPage } from '../browser.js';
import { fetchBuffer } from '../net.js';
import { detectClosure } from '../closure.js';
import { extractMenu, menuFromLines } from './extract.js';
import { pdfToLines } from './pdf.js';

const looksPdf = (u) => /\.pdf($|[?#])/i.test(u) || /static1\.squarespace\.com\/static\/.+\/t\//i.test(u) || /\.wixstatic\.com\/ugd\//i.test(u);

async function readPdf(url) {
  const { buffer, contentType } = await fetchBuffer(url);
  if (!/pdf/i.test(contentType) && buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  return { items: menuFromLines(await pdfToLines(buffer)), source: 'pdf', links: [], orderLinks: [], hints: {}, menuUrls: [] };
}

async function readPage(browser, url) {
  if (looksPdf(url)) return readPdf(url);
  try {
    const page = await renderPage(browser, url, { timeoutMs: 40000 });
    const r = extractMenu(page.html, page.url);
    // Menus often live in an embedded widget (BentoBox, Popmenu, SinglePlatform...).
    for (const f of page.frames) {
      if (r.items.length >= 5) break;
      const fr = extractMenu(f.html, f.url);
      if (fr.items.length > r.items.length) Object.assign(r, { items: fr.items, source: fr.source });
    }
    return { ...r, url: page.url, closure: detectClosure(page.html) };
  } catch (e) {
    if (/download/i.test(e.message)) return readPdf(url);
    throw e;
  }
}

/**
 * Returns { items, menuUrl, menuSource, orderLinks, dine, takeout, delivery, closure, error }.
 * dine/takeout/delivery are true when the site says so, otherwise undefined.
 */
export async function scrapeMenu(browser, r, { log = console.log } = {}) {
  const out = { items: [], menuUrl: '', menuSource: '', orderLinks: [], closure: null };
  const hints = {};
  const addHints = (h = {}) => {
    for (const k of ['dine', 'takeout', 'delivery']) if (h[k]) hints[k] = true;
  };
  const orders = new Map();
  const addOrders = (list = []) => list.forEach((o) => orders.has(o.id) || orders.set(o.id, o));

  const start = r.menuUrl || r.website;
  const home = await readPage(browser, start);
  out.closure = home.closure || null;
  addHints(home.hints);
  addOrders(home.orderLinks);
  let best = { items: home.items, url: home.url || start, source: home.source };

  if (best.items.length < 12) {
    const tried = new Set([start, home.url]);
    const next = [...(home.menuUrls || []), ...(home.links || [])].filter((u) => !tried.has(u)).slice(0, 3);
    for (const u of next) {
      tried.add(u);
      try {
        const res = await readPage(browser, u);
        addHints(res.hints);
        addOrders(res.orderLinks);
        if (!out.menuUrl) out.menuUrl = u; // a menu link is useful even if we can't read it
        if (res.items.length > best.items.length) best = { items: res.items, url: res.url || u, source: res.source };
        if (best.items.length >= 12) break;
      } catch (e) {
        log(`    menu link failed: ${u}: ${e.message}`);
      }
    }
  }
  out.items = best.items;
  if (best.items.length) {
    out.menuUrl = best.url;
    out.menuSource = best.source;
  }
  out.orderLinks = [...orders.values()];
  for (const o of out.orderLinks) {
    if (o.delivery) hints.delivery = true;
    if (o.takeout) hints.takeout = true;
  }
  return { ...out, ...hints };
}
