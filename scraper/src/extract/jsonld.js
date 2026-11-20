import * as cheerio from 'cheerio';

const isEventType = (t) =>
  [].concat(t || []).some((x) => typeof x === 'string' && /Event$/.test(x.replace(/^.*[/:]/, '')));

function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // Common breakage: raw control characters / trailing commas.
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, depth + 1);
    return;
  }
  if (isEventType(node['@type'])) yield node;
  for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'event', 'events', 'mainEntity']) {
    if (node[key]) yield* walk(node[key], depth + 1);
  }
}

function placeToString(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc)) return placeToString(loc[0]);
  const addr = loc.address;
  const addrStr =
    typeof addr === 'string'
      ? addr
      : addr
        ? [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ')
        : '';
  return [loc.name, addrStr].filter(Boolean).join(' — ');
}

function priceOf(offers) {
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o) return '';
  if (o.price === 0 || o.price === '0' || o.price === '0.00') return 'Free';
  const cur = !o.priceCurrency || o.priceCurrency === 'USD' ? '$' : o.priceCurrency + ' ';
  if (o.price != null && o.price !== '') return `${cur}${o.price}`;
  if (o.lowPrice != null) return `${cur}${o.lowPrice}${o.highPrice ? '–' + o.highPrice : ''}`;
  return '';
}

export function eventsFromJsonLdNodes(nodes, source = 'jsonld') {
  const out = [];
  for (const n of nodes) {
    if (!n.startDate) continue;
    const status = String(n.eventStatus || '');
    out.push({
      title: n.name,
      start: n.startDate,
      end: n.endDate,
      description: n.description,
      url: n.url || n['@id'],
      image: n.image,
      location: placeToString(n.location),
      price: n.isAccessibleForFree === true ? 'Free' : priceOf(n.offers),
      cancelled: /Cancelled|Postponed/i.test(status),
      organizer: [].concat(n.organizer || [])[0]?.name || '',
      sourceCategories: [].concat(n['@type'] || []).filter((t) => t !== 'Event'),
      source,
    });
  }
  return out;
}

export function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const data = parseLoose($(el).text());
    if (data) nodes.push(...walk(data));
  });
  return eventsFromJsonLdNodes(nodes);
}
