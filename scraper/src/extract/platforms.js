// Adapters for common website platforms that expose event data as JSON.
import { fetchJson } from '../net.js';

/** Squarespace event collections answer `?format=json` with upcoming events. */
export function eventsFromSquarespaceJson(data, pageUrl) {
  const items = [...(data?.upcoming || []), ...(data?.items || []).filter((i) => i.startDate)];
  return items
    .filter((i) => i.startDate && i.title)
    .map((i) => {
      const loc = i.location || {};
      return {
        title: i.title,
        start: new Date(i.startDate),
        end: i.endDate ? new Date(i.endDate) : null,
        description: i.excerpt || i.body,
        url: i.fullUrl ? new URL(i.fullUrl, pageUrl).toString() : pageUrl,
        image: i.assetUrl,
        location: [loc.addressTitle, loc.addressLine1, loc.addressLine2].filter(Boolean).join(', '),
        sourceCategories: [...(i.categories || []), ...(i.tags || [])],
        source: 'squarespace',
      };
    });
}

export async function extractSquarespace(ctx) {
  if (!/squarespace/i.test(ctx.html)) return [];
  const u = new URL(ctx.url);
  u.searchParams.set('format', 'json');
  try {
    return eventsFromSquarespaceJson(await fetchJson(u.toString()), ctx.url);
  } catch {
    return [];
  }
}

/** WordPress "The Events Calendar" plugin REST API. */
export function eventsFromTribeJson(data) {
  return (data?.events || []).map((e) => ({
    title: e.title,
    start: e.all_day ? e.start_date.slice(0, 10) : e.utc_start_date ? e.utc_start_date.replace(' ', 'T') + 'Z' : e.start_date,
    end: e.all_day ? null : e.utc_end_date ? e.utc_end_date.replace(' ', 'T') + 'Z' : e.end_date,
    allDay: !!e.all_day,
    description: e.excerpt || e.description,
    url: e.url,
    image: e.image?.url,
    location: e.venue?.venue,
    price: e.cost,
    sourceCategories: (e.categories || []).map((c) => c.name),
    source: 'tribe',
  }));
}

export async function extractTribe(ctx) {
  if (!/tribe-events|tribe_events|the-events-calendar/i.test(ctx.html)) return [];
  const url = new URL('/wp-json/tribe/events/v1/events?per_page=100&start_date=now', ctx.url).toString();
  try {
    return eventsFromTribeJson(await fetchJson(url));
  } catch {
    return [];
  }
}
