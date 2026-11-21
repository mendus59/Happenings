// Restaurants: shared definitions for the daily restaurants job and the web app.
// Places come from OpenStreetMap; menus and ordering links come from each restaurant's own site.
import { areaFor, distanceKm, normalizeBox } from './geo.js';

/** The three ways to eat; each has its own map box and its own favorite / disliked rating. */
export const MODES = {
  dine: { label: 'Dine-in', icon: '🍽️', boxHint: 'places you would drive to for a sit-down meal' },
  takeout: { label: 'Takeout', icon: '🥡', boxHint: 'places close enough to pick food up' },
  delivery: { label: 'Delivery', icon: '🛵', boxHint: 'places that could deliver to you' },
};
export const MODE_IDS = Object.keys(MODES);
export const RATINGS = ['fav', 'dislike'];

const AMENITIES = ['restaurant', 'fast_food', 'cafe', 'food_court', 'pub', 'ice_cream', 'biergarten'];

/** Overpass QL for restaurants inside a box. */
export function restaurantQuery(box, timeout = 90) {
  const bb = `(${[box.s, box.w, box.n, box.e].join(',')})`;
  return `[out:json][timeout:${timeout}];(nwr["amenity"~"^(${AMENITIES.join('|')})$"]["name"]${bb};nwr["shop"~"^(bakery|deli|pastry)$"]["name"]${bb};);out center tags;`;
}

/** Restaurant ids are stable OSM ids: r_node_123. */
export const restaurantId = (el) => `r_${el.type}_${el.id}`;

const CUISINE_LABELS = {
  american: 'American', burger: 'Burgers', pizza: 'Pizza', mexican: 'Mexican', tex_mex: 'Tex-Mex', italian: 'Italian',
  chinese: 'Chinese', japanese: 'Japanese', sushi: 'Sushi', ramen: 'Ramen', thai: 'Thai', vietnamese: 'Vietnamese',
  pho: 'Pho', korean: 'Korean', indian: 'Indian', nepalese: 'Nepalese', greek: 'Greek', mediterranean: 'Mediterranean',
  middle_eastern: 'Middle Eastern', lebanese: 'Lebanese', turkish: 'Turkish', french: 'French', spanish: 'Spanish',
  german: 'German', seafood: 'Seafood', fish_and_chips: 'Fish & Chips', steak_house: 'Steakhouse', bbq: 'BBQ',
  barbecue: 'BBQ', sandwich: 'Sandwiches', deli: 'Deli', chicken: 'Chicken', fried_chicken: 'Chicken', wings: 'Wings',
  breakfast: 'Breakfast', brunch: 'Brunch', diner: 'Diner', coffee_shop: 'Coffee', coffee: 'Coffee', tea: 'Tea',
  bubble_tea: 'Bubble Tea', donut: 'Donuts', bagel: 'Bagels', bakery: 'Bakery', dessert: 'Dessert', ice_cream: 'Ice Cream',
  frozen_yogurt: 'Frozen Yogurt', vegan: 'Vegan', vegetarian: 'Vegetarian', salad: 'Salads', hawaiian: 'Hawaiian',
  poke: 'Poke', filipino: 'Filipino', caribbean: 'Caribbean', ethiopian: 'Ethiopian', asian: 'Asian', noodle: 'Noodles',
  regional: 'Regional', pacific_northwest: 'Pacific Northwest', teriyaki: 'Teriyaki', taco: 'Tacos', burrito: 'Burritos',
  hot_dog: 'Hot Dogs', soup: 'Soup', crepe: 'Crêpes', juice: 'Juice', smoothie: 'Smoothies', pasta: 'Pasta',
};

const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** OSM cuisine tag ("pizza;italian") to display labels. */
export function cuisinesFromTags(t = {}) {
  const raw = String(t.cuisine || '')
    .toLowerCase()
    .split(/[;,]/)
    .map((s) => s.trim().replace(/\s+/g, '_'))
    .filter(Boolean);
  if (!raw.length) {
    if (t.amenity === 'cafe') raw.push('coffee_shop');
    else if (t.amenity === 'ice_cream') raw.push('ice_cream');
    else if (t.shop === 'bakery' || t.shop === 'pastry') raw.push('bakery');
    else if (t.shop === 'deli') raw.push('deli');
  }
  return [...new Set(raw.map((c) => CUISINE_LABELS[c] || titleCase(c)))].slice(0, 6);
}

const yesNo = (v) => (v == null ? null : /^(yes|only|true)$/i.test(v) ? true : /^no$/i.test(v) ? false : null);

/** Normalize an Overpass element into a restaurant (null if unusable). */
export function restaurantFromElement(el) {
  const t = el.tags || {};
  if (!t.name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  if (t['disused:amenity'] || t.opening_hours === 'closed') return null;
  let website = t.website || t['contact:website'] || t.url || '';
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const kind = t.amenity || t.shop || 'restaurant';
  const takeaway = t.takeaway;
  return {
    id: restaurantId(el),
    name: t.name,
    kind,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    cuisines: cuisinesFromTags(t),
    website,
    phone: t.phone || t['contact:phone'] || '',
    address: [street, t['addr:city']].filter(Boolean).join(', '),
    city: t['addr:city'] || '',
    hours: t.opening_hours || '',
    // true / false / null (unknown). Delivery and takeout can also be learned from the site.
    dine: takeaway === 'only' ? false : yesNo(t.indoor_seating) ?? (['restaurant', 'pub', 'food_court', 'biergarten'].includes(kind) ? true : null),
    takeout: yesNo(takeaway) ?? (['fast_food', 'cafe', 'ice_cream', 'bakery', 'deli', 'pastry'].includes(kind) ? true : null),
    delivery: yesNo(t.delivery),
    orderUrl: t['website:menu'] ? '' : t['contact:order'] || t['url:order'] || '',
    menuUrl: t['website:menu'] || t['menu:url'] || '',
    // Opening date when mappers recorded one (YYYY, YYYY-MM or YYYY-MM-DD).
    since: osmDate(t.start_date || t.opening_date),
  };
}

/** OSM date tag to YYYY / YYYY-MM / YYYY-MM-DD, or '' for vague values ("before 1990", "1990s"). */
export function osmDate(v) {
  const m = String(v || '').trim().replace(/^~/, '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m || +m[1] < 1800 || +m[1] > 2100) return '';
  return [m[1], m[2], m[3]].filter(Boolean).join('-');
}

// ---------- opening dates ----------

const NAME_NOISE = new Set(['the', 'and', 'of', 'llc', 'inc', 'co', 'restaurant', 'bar', 'grill', 'cafe', 'café', 'kitchen', 'eatery', 'tavern', 'pub', 'company', 'corp', 'dba', 'at', 'on', 'wa']);
const nameWords = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NAME_NOISE.has(w));

/** Do two business names look like the same place? ("Bay Thai LLC" ~ "Bay Thai Restaurant") */
export function sameName(a, b) {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  const ys = new Set(y);
  const shared = x.filter((w) => ys.has(w)).length;
  return shared / Math.min(x.length, y.length) >= 0.6 || x.join('') === y.join('');
}

/** The restaurant a liquor-license notice belongs to: similar name, within about 250 m. */
export function matchLicense(list, notice) {
  let best = null;
  for (const r of list) {
    if (String(r.id).startsWith('r_lcb_')) continue;
    const d = distanceKm(r, notice);
    if (d <= 0.25 && sameName(r.name, notice.name) && (!best || d < best.d)) best = { r, d };
  }
  return best?.r || null;
}

/** Restaurant id for a place known only from a license notice (not on the map yet). */
export const licenseRestaurantId = (notice) => `r_lcb_${String(notice.license || '').replace(/\D/g, '').slice(0, 15)}`;

/**
 * When a restaurant opened, best source first: a liquor-license notice, then the map's own
 * start date, then the day it first appeared on the map. Returns { date, src } or null.
 */
export function openedOf(r) {
  if (r.license?.date) return { date: r.license.date, src: 'license' };
  if (r.since) return { date: r.since, src: 'map' };
  if (r.firstSeen) return { date: r.firstSeen, src: 'seen' };
  return null;
}

/** Rough price level 1–4 from menu prices (median of mains-ish items), or 0 when unknown. */
export function priceLevel(items = []) {
  const prices = items.map((i) => i.p).filter((p) => typeof p === 'number' && p >= 4 && p < 300).sort((a, b) => a - b);
  if (prices.length < 4) return 0;
  const median = prices[Math.floor(prices.length / 2)];
  return median < 12 ? 1 : median < 20 ? 2 : median < 32 ? 3 : 4;
}

export const priceLabel = (n) => (n ? '$'.repeat(n) : '');

/** Known ordering services, matched by link host. */
export const ORDER_SERVICES = [
  { id: 'doordash', label: 'DoorDash', re: /(^|\.)doordash\.com$/, delivery: true },
  { id: 'grubhub', label: 'Grubhub', re: /(^|\.)grubhub\.com$|(^|\.)seamless\.com$/, delivery: true },
  { id: 'ubereats', label: 'Uber Eats', re: /(^|\.)ubereats\.com$|(^|\.)postmates\.com$/, delivery: true },
  { id: 'toast', label: 'Toast (order online)', re: /(^|\.)toasttab\.com$/, takeout: true },
  { id: 'square', label: 'Order online (Square)', re: /\.square\.site$|(^|\.)squareup\.com$/, takeout: true },
  { id: 'chownow', label: 'ChowNow', re: /(^|\.)chownow\.com$/, takeout: true },
  { id: 'slice', label: 'Slice', re: /(^|\.)slicelife\.com$/, takeout: true, delivery: true },
  { id: 'olo', label: 'Order online', re: /(^|\.)olo\.com$|(^|\.)order\.online$/, takeout: true },
  { id: 'clover', label: 'Order online (Clover)', re: /(^|\.)clover\.com$/, takeout: true },
  { id: 'menufy', label: 'Menufy', re: /(^|\.)menufy\.com$/, takeout: true, delivery: true },
  { id: 'beyondmenu', label: 'BeyondMenu', re: /(^|\.)beyondmenu\.com$/, takeout: true, delivery: true },
  { id: 'popmenu', label: 'Order online', re: /(^|\.)popmenu\.com$/, takeout: true },
  { id: 'owner', label: 'Owner.com', re: /(^|\.)owner\.com$/, takeout: true, delivery: true },
  { id: 'spoton', label: 'Order online', re: /(^|\.)spoton\.com$/, takeout: true },
];

export function serviceForUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ORDER_SERVICES.find((s) => s.re.test(host)) || null;
  } catch {
    return null;
  }
}

/** Search links on the big delivery apps (we can't read their listings, but can link to a search). */
export function deliverySearchLinks(r) {
  const q = encodeURIComponent([r.name, r.city].filter(Boolean).join(' '));
  return [
    { id: 'doordash', label: 'DoorDash', url: `https://www.doordash.com/search/store/${q}/`, search: true },
    { id: 'grubhub', label: 'Grubhub', url: `https://www.grubhub.com/search?queryText=${q}`, search: true },
    { id: 'ubereats', label: 'Uber Eats', url: `https://www.ubereats.com/search?q=${q}`, search: true },
  ];
}

/**
 * Areas the restaurants job maintains for a user's boxes: one snapped area per box,
 * leaving out any that another of the areas already covers.
 */
export function areasForBoxes(boxes) {
  const areas = new Map();
  for (const b of boxes) {
    const a = areaFor(normalizeBox(b));
    if (a) areas.set(a.id, a);
  }
  const list = [...areas.values()];
  const covers = (a, b) => a !== b && a.s <= b.s && a.w <= b.w && a.n >= b.n && a.e >= b.e;
  return list.filter((b) => !list.some((a) => covers(a, b) && !(covers(b, a) && a.id > b.id)));
}
