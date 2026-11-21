// Washington State Liquor and Cannabis Board "On Premise Licensees" spreadsheet: every
// restaurant, tavern and bar licensed (or applying) to serve alcohol, with addresses and
// application / issue dates. Posted on lcb.wa.gov about monthly under a dated file name, so the
// current link is read from the "Frequently Requested Lists" page each time.
import ExcelJS from 'exceljs';
import { fetchBuffer, fetchText } from '../net.js';

export const LISTS_PAGE = 'https://lcb.wa.gov/records/frequently-requested-lists';

/** Licenses a restaurant-like place holds (snack bar licenses also cover barber shops etc.). */
const FOOD_PRIV = /REST|TAVERN|PUBLIC HOUSE|BREW|NIGHTCLUB|CATER/i;
const LIVE_STATUS = /ACTIVE|PENDING/i;
const OPENING_REASON = /^(NEW|ASSUMPTION|CHANGE OF LOCATION|ADDED|ADD)/i;

const ymd = (v) => {
  const s = String(v ?? '').trim();
  if (/^\d{8}$/.test(s) && s !== '19000101' && s !== '00000000') return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  return '';
};
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const titleCase = (s) =>
  clean(s)
    .toLowerCase()
    .replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\b(Llc|Inc|Bbq|Kbbq)\b/g, (m) => m.toUpperCase())
    .replace(/\b(Ne|Nw|Se|Sw)\b/g, (m) => m.toUpperCase());

/** Find the current On Premise spreadsheet link on the lists page. */
export function onPremiseUrlFrom(html) {
  const links = [...String(html).matchAll(/href="([^"]+\.xlsx?)"/gi)].map((m) => m[1]);
  const hit = links.find((l) => /on(%20|\s|_|-)?premise/i.test(l));
  if (!hit) return null;
  return hit.startsWith('http') ? hit : new URL(hit, LISTS_PAGE).href;
}

/**
 * Pure: spreadsheet rows (arrays, first row = headers) -> one record per license, food and
 * drink places only, live licenses only.
 */
export function licenseesFromRows(rows) {
  const [head, ...body] = rows;
  const col = Object.fromEntries((head || []).map((h, i) => [clean(h).toLowerCase(), i]));
  const get = (r, name) => r[col[name]];
  const byLicense = new Map();
  for (const r of body) {
    const license = clean(get(r, 'license number')).replace(/\D/g, '');
    const privilege = clean(get(r, 'privilege'));
    const status = clean(get(r, 'status')).toUpperCase();
    if (!license || !LIVE_STATUS.test(status) || !FOOD_PRIV.test(privilege)) continue;
    const reason = clean(get(r, 'reason description')).toUpperCase();
    const applied = ymd(get(r, 'application date'));
    const rec = byLicense.get(license) || {
      license,
      name: titleCase(get(r, 'tradename')),
      street: clean(get(r, 'loc address')),
      city: clean(get(r, 'loc city')).toUpperCase(),
      state: clean(get(r, 'loc st')) || 'WA',
      zip: clean(get(r, 'loc zip')).slice(0, 5),
      county: clean(get(r, 'county')).toUpperCase(),
      status,
      privileges: [],
      reason,
      applied,
      issued: ymd(get(r, 'issue date')),
    };
    if (!rec.privileges.includes(privilege)) rec.privileges.push(privilege);
    // Prefer the row that explains how the license started (new / takeover / move).
    if (OPENING_REASON.test(reason) && !OPENING_REASON.test(rec.reason)) Object.assign(rec, { reason, applied });
    if (/PENDING/.test(status)) rec.status = status;
    byLicense.set(license, rec);
  }
  return [...byLicense.values()];
}

/** A license record as an opening notice (dated) or a plain "licensed here" record. */
export function noticeFromLicensee(l, lat, lon) {
  const opening = OPENING_REASON.test(l.reason) && l.applied;
  const type = /CHANGE OF LOCATION/.test(l.reason) ? 'moved' : /ASSUMPTION/.test(l.reason) ? 'new-owner' : 'new';
  const what = type === 'moved' ? 'Moved to this location' : type === 'new-owner' ? 'New owner took over the liquor license' : 'New liquor license';
  const priv = titleCase(l.privileges.join(' · '));
  return {
    license: l.license,
    name: l.name,
    lat,
    lon,
    address: titleCase([l.street, l.city].filter(Boolean).join(', ')),
    date: opening ? l.applied : '',
    licenseType: type,
    status: /PENDING/.test(l.status) ? 'pending' : 'active',
    detail: opening ? `${what} (applied ${l.applied}${l.issued && !/PENDING/.test(l.status) ? `, issued ${l.issued}` : ', not issued yet'}): ${priv}` : `Licensed: ${priv}`,
    kind: /REST/i.test(priv) || !/TAVERN|NIGHTCLUB|BREW/i.test(priv) ? 'restaurant' : /BREW/i.test(priv) ? 'brewery' : 'bar',
  };
}

export async function fetchOnPremiseLicensees(log = console.log) {
  const url = onPremiseUrlFrom(await fetchText(LISTS_PAGE, { timeoutMs: 60000, accept: 'text/html' }));
  if (!url) throw new Error('On Premise list link not found on the LCB page');
  const { buffer } = await fetchBuffer(url, { timeoutMs: 120000, maxBytes: 40_000_000 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && 'text' in v ? v.text : v))));
  const list = licenseesFromRows(rows);
  log(`LCB On Premise list: ${rows.length - 1} rows, ${list.length} food & drink licenses (${decodeURIComponent(url.split('/').pop())})`);
  return list;
}

/**
 * Every licensed food & drink place in the state with coordinates, as notices
 * (see noticeFromLicensee). Needs Firestore for the geocode cache. Returns [] on failure.
 */
export async function fetchLicensedPlaces(db, log = console.log, { only } = {}) {
  try {
    const { geocodeAll, addressKey } = await import('./geocode.js');
    let list = await fetchOnPremiseLicensees(log);
    if (only) list = list.filter(only);
    const coords = await geocodeAll(db, list, { log });
    const out = [];
    for (const l of list) {
      const c = coords.get(addressKey(l));
      if (c) out.push(noticeFromLicensee(l, c.lat, c.lon));
    }
    log(`Licensed places with coordinates: ${out.length} of ${list.length}`);
    return out;
  } catch (e) {
    log(`LCB On Premise list unavailable: ${e.message}`);
    return [];
  }
}
