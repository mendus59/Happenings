// OpenStreetMap place kinds used for the map, suggestions, and openings/closings.

export const PLACE_KINDS = {
  restaurant: { label: 'Restaurant', icon: '🍽️', group: 'food', hue: 15 },
  cafe: { label: 'Café', icon: '☕', group: 'food', hue: 30 },
  bakery: { label: 'Bakery', icon: '🥐', group: 'food', hue: 35 },
  bar: { label: 'Bar / Pub', icon: '🍺', group: 'drink', hue: 45 },
  brewery: { label: 'Brewery / Cidery / Winery', icon: '🍎', group: 'drink', hue: 0 },
  venue: { label: 'Music & Event Venue', icon: '🎵', group: 'venue', hue: 265 },
  theatre: { label: 'Theater & Cinema', icon: '🎭', group: 'venue', hue: 240 },
  arts: { label: 'Gallery & Arts Center', icon: '🎨', group: 'arts', hue: 290 },
  community: { label: 'Community Space', icon: '🤝', group: 'community', hue: 185 },
  farm: { label: 'Farm & Market', icon: '🌾', group: 'outdoors', hue: 100 },
  attraction: { label: 'Museum & Attraction', icon: '🏛️', group: 'arts', hue: 210 },
  books: { label: 'Bookstore', icon: '📚', group: 'arts', hue: 320 },
};

/** Decide a place's kind from its OSM tags (null = not interesting). */
export function kindFromTags(t = {}) {
  const a = t.amenity;
  if (['restaurant', 'fast_food', 'food_court'].includes(a)) return 'restaurant';
  if (['cafe', 'ice_cream'].includes(a)) return 'cafe';
  if (['bar', 'pub', 'biergarten', 'nightclub'].includes(a)) return 'bar';
  if (['music_venue', 'events_venue', 'concert_hall'].includes(a) || t.leisure === 'dance') return 'venue';
  if (['theatre', 'cinema'].includes(a)) return 'theatre';
  if (a === 'arts_centre' || t.tourism === 'gallery' || t.shop === 'art') return 'arts';
  if (a === 'community_centre' || a === 'library' || a === 'marketplace') return a === 'marketplace' ? 'farm' : 'community';
  if (['brewery', 'winery', 'distillery', 'cider'].includes(t.craft) || t.shop === 'alcohol' && /cider|winery|brew/i.test(t.name || '')) return 'brewery';
  if (t.shop === 'farm' || t.landuse === 'farmyard' && t.website || t.tourism === 'farm') return 'farm';
  if (t.shop === 'bakery') return 'bakery';
  if (t.shop === 'books') return 'books';
  if (['museum', 'attraction', 'zoo', 'aquarium'].includes(t.tourism)) return 'attraction';
  return null;
}

/** OSM "food & drink" kinds tracked for openings/closings. */
export const FOOD_DRINK_KINDS = new Set(['restaurant', 'cafe', 'bakery', 'bar', 'brewery']);

const SELECTORS = [
  'nwr["amenity"~"^(restaurant|fast_food|food_court|cafe|ice_cream|bar|pub|biergarten|nightclub|music_venue|events_venue|concert_hall|theatre|cinema|arts_centre|community_centre|library|marketplace)$"]',
  'nwr["craft"~"^(brewery|winery|distillery|cider)$"]',
  'nwr["shop"~"^(farm|bakery|books|art)$"]',
  'nwr["tourism"~"^(gallery|museum|attraction|zoo|aquarium)$"]',
];

/** Overpass QL for interesting places around a point or inside a bbox [s,w,n,e]. */
export function overpassQuery({ around, bbox, onlyFoodDrink = false, timeout = 50 }) {
  const filter = around ? `(around:${Math.round(around.radiusKm * 1000)},${around.lat},${around.lon})` : `(${bbox.join(',')})`;
  const sels = onlyFoodDrink ? [SELECTORS[0], SELECTORS[1], 'nwr["shop"="bakery"]'] : SELECTORS;
  return `[out:json][timeout:${timeout}];(${sels.map((s) => s + filter + ';').join('')});out center tags;`;
}

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Normalize an Overpass element into a place. */
export function placeFromElement(el) {
  const t = el.tags || {};
  const kind = kindFromTags(t);
  if (!kind || !t.name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const website = t.website || t['contact:website'] || t.url || '';
  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    id: `${el.type}/${el.id}`,
    name: t.name,
    kind,
    lat,
    lon,
    website: website && !/^https?:\/\//i.test(website) ? 'https://' + website : website,
    address: [addr, t['addr:city']].filter(Boolean).join(', '),
    closed: !!(t['disused:amenity'] || t['was:amenity'] || t.opening_hours === 'closed'),
  };
}
