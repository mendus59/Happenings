// Shared between the browser app and the scraper so both derive the same venue id.

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|_ga$|ref$)/i;

/** Normalize a user-entered venue URL. Returns null if it isn't a usable http(s) URL. */
export function normalizeVenueUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hostname = u.hostname.toLowerCase();
  let out = u.toString();
  if (u.pathname !== '/' && out.endsWith('/') && !u.search) out = out.slice(0, -1);
  return out;
}

/** The identity key of a venue URL: host without "www.", path without trailing slash, plus query. */
export function venueKey(normalizedUrl) {
  const u = new URL(normalizedUrl);
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}${u.search}`;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable venue document id (works in browsers and Node 20+, both expose crypto.subtle). */
export async function venueIdFor(normalizedUrl) {
  const data = new TextEncoder().encode(venueKey(normalizedUrl));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return 'v_' + hex(digest).slice(0, 20);
}
