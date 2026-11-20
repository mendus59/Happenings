// "Nearby" tab: home area, a map of local places (click to track), openings & closings,
// and opt-in suggestions. Map data comes from OpenStreetMap (free).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PLACE_KINDS, overpassQuery, placeFromElement, OVERPASS_URL } from '../../shared/places.js';
import { MAX_BOX, boxAround, boxCenter, boxSizeKm, distanceKm, inBox, normalizeBox, profileBox, siteKey } from '../../shared/geo.js';
import { esc, safeHref, loadPref, savePref } from './util.js';

const KM_PER_MI = 1.609344;
const GREEN = '#2f6b4f';
const nb = {
  map: null,
  layer: null,
  rect: null, // the home-area rectangle on the map
  handles: [], // drag handles while editing
  draft: null, // { box, label } while the user is drawing their area
  fitPending: false,
  places: new Map(), // id -> place (everything fetched so far)
  fetchedBoxes: [],
  loadingPlaces: false,
  kinds: new Set(loadPref('nearbyKinds', Object.keys(PLACE_KINDS))),
  suggestions: null, // { key, list }
  suggesting: false,
  dismissed: new Set(loadPref('dismissedSuggestions', [])),
  formMsg: '',
  busy: false,
  showAllChanges: false,
};

// ---------- data ----------

async function overpass(q) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: q }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'The map server is busy. Try again in a minute.' : `Map server error (${res.status})`);
  const json = await res.json();
  return (json.elements || []).map(placeFromElement).filter(Boolean);
}

export async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Address lookup failed. Try again in a moment.');
  const [hit] = await res.json();
  if (!hit) throw new Error("Couldn't find that place. Try a town name, like “Port Townsend, WA”.");
  const a = hit.address || {};
  const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
  const label = [town, a.state_code || a.state].filter(Boolean).join(', ') || hit.display_name.split(',').slice(0, 2).join(',');
  return { lat: Number(hit.lat), lon: Number(hit.lon), label };
}

function trackedSites(state) {
  return new Set([...state.subscriptions.values()].map((s) => siteKey(s.url)));
}

const savedBox = (state) => profileBox(state.profile);

const boxKey = (b) => (b ? [b.s, b.w, b.n, b.e].join(',') : 'none');


// ---------- rendering ----------

export function renderNearby(ctx) {
  const { state, $app } = ctx;
  nb.ctx = ctx;
  const box = savedBox(state);
  const showMap = !!(box || nb.draft);
  const key = showMap ? (box ? 'saved' : 'draft') : 'none';
  // Keep the live map across rerenders; only rebuild the page when its layout changes.
  if ($app.dataset.page !== 'nearby' || $app.dataset.home !== key) {
    teardownMap();
    $app.dataset.page = 'nearby';
    $app.dataset.home = key;
    $app.innerHTML = `
      <section class="nearby">
        <div id="nb-area"></div>
        ${
          showMap
            ? `<div class="nb-grid ${box ? '' : 'solo'}">
                <div class="nb-mapcol">
                  <div id="nb-kinds" class="chips"></div>
                  <div id="nb-map" role="region" aria-label="Map of nearby places"></div>
                  <p class="hint" id="nb-maphint">Click a place to see it and track its events.</p>
                </div>
                ${box ? '<aside class="nb-side"><section id="nb-changes"></section><section id="nb-suggest"></section></aside>' : ''}
              </div>`
            : ''
        }
      </section>`;
    if (showMap) setupMap(ctx);
  }
  renderArea(ctx);
  if (showMap) {
    renderKinds();
    drawBox();
    drawPlaces(ctx);
  }
  if (box) {
    renderChanges(ctx);
    renderSuggestions(ctx);
  }
}

export function leaveNearby($app) {
  if ($app.dataset.page === 'nearby') teardownMap();
  delete $app.dataset.page;
  delete $app.dataset.home;
}

const sizeText = (b) => {
  const { tall, wide } = boxSizeKm(b);
  return `About ${Math.round(wide / KM_PER_MI)} × ${Math.round(tall / KM_PER_MI)} miles`;
};

const msgHtml = () => (nb.formMsg ? `<div class="notice ${nb.formMsg.startsWith('!') ? 'error' : ''}">${esc(nb.formMsg.replace(/^!/, ''))}</div>` : '');

function renderArea({ state }) {
  const el = document.getElementById('nb-area');
  if (!el) return;
  const p = state.profile || {};
  const box = savedBox(state);
  const findForm = (placeholder, button) => `
    <form class="filter-row" data-action="nb-find">
      <input name="place" type="text" placeholder="${placeholder}" aria-label="Town or address" required>
      <button type="submit" ${nb.busy ? 'disabled' : ''}>${button}</button>
      <button type="button" data-action="nb-locate" title="Use this device's location">📍 Use my location</button>
    </form>`;

  if (nb.draft) {
    el.innerHTML = `
      <div class="nb-area-form editing">
        <div class="nb-area-title">
          <h2>Draw your area</h2>
          <p class="hint">Drag the corners of the green box (or the ✥ in the middle to move it) so it covers the places you actually go.
            Leave out spots that look close but take a long time to reach, like the other side of the water.
            Only the box is saved, never your address.</p>
        </div>
        ${findForm('Jump to a town', 'Go')}
        <div class="filter-row">
          <span class="sub" id="nb-size">${esc(sizeText(nb.draft.box))}</span>
          <button type="button" data-action="nb-use-view">Use the whole map view</button>
          <button type="button" class="primary" data-action="nb-save-box" ${nb.busy ? 'disabled' : ''}>Save area</button>
          ${box ? '<button type="button" class="link" data-action="nb-cancel-edit">Cancel</button>' : ''}
        </div>
        ${msgHtml()}
      </div>`;
    return;
  }
  if (!box) {
    el.innerHTML = `
      <div class="nb-area-form">
        <div class="nb-area-title">
          <h2>Set your home area</h2>
          <p class="hint">Find your town, then draw a box on the map around the places you’d travel to. You’ll see local places to track,
            new openings and closings, and (if you like) suggestions.</p>
        </div>
        ${findForm('Your town, e.g. “Port Orchard, WA”', 'Find')}
        ${msgHtml()}
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="nb-area-form">
      <div class="nb-area-title">
        <h2>Around ${esc(p.homeLabel || 'home')}</h2>
        <span class="sub">${esc(sizeText(box))}</span>
        <button type="button" class="link" data-action="nb-edit-area">Change area</button>
      </div>
      ${msgHtml()}
      <label class="toggle"><input type="checkbox" data-action="nb-suggest-toggle" ${p.suggestions ? 'checked' : ''}> Suggest places based on the venues I track</label>
    </div>`;
}

function renderKinds() {
  const el = document.getElementById('nb-kinds');
  if (!el) return;
  el.innerHTML = Object.entries(PLACE_KINDS)
    .map(
      ([id, k]) =>
        `<button class="chip ${nb.kinds.has(id) ? 'on' : ''}" style="--hue:${k.hue}" data-action="nb-kind" data-kind="${id}" aria-pressed="${nb.kinds.has(id)}">${k.icon} ${esc(k.label)}</button>`,
    )
    .join('');
}

function changeItem(state, c, tracked) {
  const k = PLACE_KINDS[c.kind] || PLACE_KINDS.restaurant;
  const isTracked = c.website && tracked.has(siteKey(c.website));
  const search = `https://www.google.com/search?q=${encodeURIComponent(`${c.name} ${c.address || ''}`)}`;
  return `<li class="change ${c.change}">
    <div class="ch-head"><span class="pill ${c.change === 'opening' ? 'open' : 'close'}">${c.change === 'opening' ? 'Opening' : 'Closing'}</span>
      <b>${esc(c.name)}</b></div>
    <div class="sub">${k.icon} ${esc(k.label)}${c.address ? ` · ${esc(c.address)}` : ''}</div>
    <div class="sub">${esc(c.detail || '')}${c.date ? ` · ${esc(c.date)}` : ''}</div>
    <div class="ch-actions">
      ${c.lat != null ? `<button class="link" data-action="nb-focus" data-lat="${c.lat}" data-lon="${c.lon}">Show on map</button>` : ''}
      ${c.website ? (isTracked ? '<span class="sub">Tracking ✓</span>' : `<button class="link" data-action="nb-track" data-url="${esc(c.website)}" data-name="${esc(c.name)}">Track events</button>`) : `<a href="${esc(search)}" target="_blank" rel="noopener">Look it up ↗</a>`}
    </div>
  </li>`;
}

function renderChanges({ state }) {
  const el = document.getElementById('nb-changes');
  if (!el) return;
  const tracked = trackedSites(state);
  const cutoff = Date.now() - 120 * 864e5;
  // Saved venues whose own site says they're closing, or that vanished.
  const venueAlerts = [...state.subscriptions.keys()]
    .map((id) => ({ sub: state.subscriptions.get(id), v: state.venues.get(id) }))
    .filter(({ v }) => v?.closure || v?.siteGone)
    .map(({ sub, v }) => ({
      id: 'v_' + v.id,
      change: 'closing',
      name: sub.label || v.name || siteKey(sub.url),
      kind: 'venue',
      detail: v.closure ? `Their website says: “${v.closure.text.slice(0, 160)}”` : 'Their website has been unreachable for several days.',
      website: '',
      date: '',
    }));
  const box = savedBox(state);
  const changes = state.areaChanges.filter((c) => {
    const t = c.date ? Date.parse(c.date) : c.detectedAt?.getTime() || 0;
    // The shared area is a little larger than this user's box; trim to their box.
    return t >= cutoff && (c.lat == null || inBox(box, c));
  });
  changes.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const all = [...venueAlerts, ...changes];
  const shown = nb.showAllChanges ? all : all.slice(0, 8);
  el.innerHTML = `
    <h3>Openings &amp; closings</h3>
    ${
      all.length
        ? `<ul class="changes">${shown.map((c) => (c.id.startsWith('v_') ? venueAlert(c) : changeItem(state, c, tracked))).join('')}</ul>
           ${all.length > shown.length ? `<button class="link" data-action="nb-more">Show all ${all.length}</button>` : ''}`
        : `<p class="hint">Nothing yet. Happenings checks Washington liquor-license notices daily (new restaurants, bars, breweries) and compares the map monthly. Your first results usually appear within a day.</p>`
    }`;
}

function venueAlert(c) {
  return `<li class="change closing"><div class="ch-head"><span class="pill close">Closing?</span> <b>${esc(c.name)}</b></div>
    <div class="sub">${esc(c.detail)}</div><div class="sub">A venue you track.</div></li>`;
}

// ---------- suggestions ----------

const CATEGORY_TO_KINDS = {
  music: ['venue', 'bar', 'brewery'],
  comedy: ['bar', 'theatre'],
  trivia: ['bar', 'brewery'],
  dance: ['venue', 'community'],
  workshop: ['arts', 'community'],
  arts: ['arts'],
  market: ['farm'],
  food: ['brewery', 'restaurant'],
  outdoors: ['farm', 'attraction'],
  film: ['theatre', 'books'],
  family: ['community', 'attraction'],
  community: ['community'],
};

async function loadSuggestions(ctx) {
  const box = savedBox(ctx.state);
  const cacheKey = boxKey(box);
  if (nb.suggesting || nb.suggestions?.key === cacheKey) return;
  nb.suggesting = true;
  try {
    let places = loadPref('placeCache', null);
    if (!places || places.key !== cacheKey || Date.now() - places.at > 864e5) {
      const list = await overpass(overpassQuery({ bbox: [box.s, box.w, box.n, box.e], timeout: 60 }));
      places = { key: cacheKey, at: Date.now(), list: list.filter((p) => p.website && !p.closed) };
      savePref('placeCache', places);
    }
    nb.suggestions = { key: cacheKey, list: places.list };
  } catch (e) {
    nb.suggestions = { key: cacheKey, list: [], error: e.message };
  } finally {
    nb.suggesting = false;
    renderSuggestions(nb.ctx || ctx);
  }
}

function rankSuggestions(state, list) {
  const tracked = trackedSites(state);
  const weights = new Map();
  // Kinds of places the user already tracks (matched by website).
  for (const p of list) if (tracked.has(siteKey(p.website))) weights.set(p.kind, (weights.get(p.kind) || 0) + 3);
  // Kinds that match the types of events they've shown interest in (or all events).
  for (const events of state.events.values()) {
    for (const ev of events.values()) {
      const r = state.reviews.get(ev.key);
      if (r === 'hidden') continue;
      const w = r === 'favorite' ? 2 : r === 'interested' ? 1 : 0.2;
      for (const k of CATEGORY_TO_KINDS[ev.category] || []) weights.set(k, (weights.get(k) || 0) + w);
    }
  }
  const box = savedBox(state);
  const mid = boxCenter(box);
  // Everything in the box is somewhere the user chose to go, so distance only breaks ties.
  return list
    .filter((p) => inBox(box, p) && !tracked.has(siteKey(p.website)) && !nb.dismissed.has(p.id))
    .map((p) => ({ ...p, score: (weights.get(p.kind) || 0) / (1 + distanceKm(mid, p) / 50) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function renderSuggestions(ctx) {
  const { state } = ctx;
  const el = document.getElementById('nb-suggest');
  if (!el) return;
  if (!state.profile?.suggestions) {
    el.innerHTML = '';
    return;
  }
  if (!nb.suggestions || nb.suggestions.key !== boxKey(savedBox(state))) {
    el.innerHTML = '<h3>Suggested for you</h3><p class="hint">Finding places like the ones you track…</p>';
    loadSuggestions(ctx);
    return;
  }
  if (nb.suggestions.error) {
    el.innerHTML = `<h3>Suggested for you</h3><p class="hint">${esc(nb.suggestions.error)}</p>`;
    return;
  }
  const list = rankSuggestions(state, nb.suggestions.list);
  el.innerHTML = `<h3>Suggested for you</h3>
    ${
      list.length
        ? `<ul class="changes">${list
            .map((p) => {
              const k = PLACE_KINDS[p.kind];
              return `<li class="change">
                <div class="ch-head"><b>${esc(p.name)}</b></div>
                <div class="sub">${k.icon} ${esc(k.label)}${p.address ? ` · ${esc(p.address)}` : ''}</div>
                <div class="ch-actions">
                  <button class="link" data-action="nb-track" data-url="${esc(p.website)}" data-name="${esc(p.name)}">Track events</button>
                  <button class="link" data-action="nb-focus" data-lat="${p.lat}" data-lon="${p.lon}">Show on map</button>
                  <a href="${esc(safeHref(p.website))}" target="_blank" rel="noopener">Website ↗</a>
                  <button class="link muted" data-action="nb-dismiss" data-id="${esc(p.id)}">Not interested</button>
                </div>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="hint">No suggestions yet. Track a few venues or review some events, and suggestions will follow.</p>'
    }`;
}

// ---------- map ----------

function setupMap(ctx) {
  const b = nb.draft?.box || savedBox(ctx.state);
  const el = document.getElementById('nb-map');
  const map = L.map(el, { scrollWheelZoom: true });
  map.fitBounds(toBounds(b));
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  nb.layer = L.layerGroup().addTo(map);
  nb.map = map;
  nb.fitPending = false;
  let timer;
  map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadPlacesInView(), 500);
  });
  loadPlacesInView();
}

const toBounds = (b) => L.latLngBounds([b.s, b.w], [b.n, b.e]);

function teardownMap() {
  nb.map?.remove();
  nb.map = null;
  nb.layer = null;
  nb.rect = null;
  nb.handles = [];
  nb.handleMap = null;
  nb.markers = null;
}

/** Draw the home-area rectangle; while editing, add corner and move handles. */
function drawBox() {
  const map = nb.map;
  if (!map) return;
  const editing = !!nb.draft;
  const b = editing ? nb.draft.box : savedBox(nb.ctx.state);
  if (!b) return;
  const style = editing
    ? { color: GREEN, weight: 3, dashArray: '6 6', fillOpacity: 0.08, interactive: false }
    : { color: GREEN, weight: 2, fillOpacity: 0.03, interactive: false };
  if (!nb.rect) nb.rect = L.rectangle(toBounds(b), style).addTo(map);
  else {
    nb.rect.setBounds(toBounds(b));
    nb.rect.setStyle(style);
  }
  if (nb.fitPending) {
    nb.fitPending = false;
    map.fitBounds(toBounds(b), { padding: [30, 30] });
  }
  if (!editing) {
    for (const h of nb.handles) h.remove();
    nb.handles = [];
    nb.handleMap = null;
    return;
  }
  if (!nb.handles.length) {
    const corner = (name) =>
      L.marker([0, 0], {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({ className: `nb-handle nb-${name}`, iconSize: [18, 18] }),
        title: 'Drag to resize your area',
      });
    const move = L.marker([0, 0], {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: 'nb-handle nb-move', html: '✥', iconSize: [26, 26] }),
      title: 'Drag to move your area',
    });
    const handles = { sw: corner('sw'), nw: corner('nw'), ne: corner('ne'), se: corner('se'), move };
    for (const [name, m] of Object.entries(handles)) {
      let start = null;
      m.on('dragstart', () => {
        start = { ...nb.draft.box, at: m.getLatLng() };
      });
      m.on('drag', () => {
        const ll = m.getLatLng();
        const next = { ...nb.draft.box };
        if (name === 'move') {
          const dLat = ll.lat - start.at.lat;
          const dLon = ll.lng - start.at.lng;
          Object.assign(next, { s: start.s + dLat, n: start.n + dLat, w: start.w + dLon, e: start.e + dLon });
        } else {
          if (name[0] === 's') next.s = Math.max(ll.lat, start.n - MAX_BOX.lat);
          else next.n = Math.min(ll.lat, start.s + MAX_BOX.lat);
          if (name[1] === 'w') next.w = Math.max(ll.lng, start.e - MAX_BOX.lon);
          else next.e = Math.min(ll.lng, start.w + MAX_BOX.lon);
        }
        nb.draft.box = next;
        placeHandles(m);
      });
      m.on('dragend', () => {
        const b2 = nb.draft.box;
        // Corners may have been dragged past each other; put the edges back in order.
        nb.draft.box = { s: Math.min(b2.s, b2.n), n: Math.max(b2.s, b2.n), w: Math.min(b2.w, b2.e), e: Math.max(b2.w, b2.e) };
        placeHandles();
      });
      m.addTo(map);
    }
    nb.handles = Object.values(handles);
    nb.handleMap = handles;
  }
  placeHandles();
}

function placeHandles(skip) {
  const b = nb.draft?.box;
  if (!b || !nb.handleMap) return;
  const h = nb.handleMap;
  const pos = { sw: [b.s, b.w], nw: [b.n, b.w], ne: [b.n, b.e], se: [b.s, b.e], move: [(b.s + b.n) / 2, (b.w + b.e) / 2] };
  for (const [name, m] of Object.entries(h)) if (m !== skip) m.setLatLng(pos[name]);
  nb.rect?.setBounds(toBounds(b));
  const size = document.getElementById('nb-size');
  if (size) size.textContent = sizeText(normalizeBox(b) || b);
}

function covered(b) {
  return nb.fetchedBoxes.some((f) => f.s <= b.s && f.w <= b.w && f.n >= b.n && f.e >= b.e);
}

async function loadPlacesInView() {
  const map = nb.map;
  if (!map) return;
  const hint = document.getElementById('nb-maphint');
  // Zoomed in: load what's in view. Zoomed out: load the user's whole area at once.
  const area = nb.draft?.box || savedBox(nb.ctx.state);
  let b;
  if (map.getZoom() >= 11) {
    const bb = map.getBounds().pad(0.25);
    b = { s: bb.getSouth(), w: bb.getWest(), n: bb.getNorth(), e: bb.getEast() };
  } else if (area && map.getZoom() >= 8 && map.getBounds().intersects(toBounds(area)) && (b = normalizeBox(area))) {
    // (b is set in the condition)
  } else {
    if (hint) hint.textContent = 'Zoom in to see places.';
    return;
  }
  if (covered(b) || nb.loadingPlaces) return;
  nb.loadingPlaces = true;
  if (hint) hint.textContent = 'Loading places…';
  try {
    const list = await overpass(overpassQuery({ bbox: [b.s, b.w, b.n, b.e].map((n) => n.toFixed(4)), timeout: 40 }));
    for (const p of list) nb.places.set(p.id, p);
    nb.fetchedBoxes.push(b);
    if (hint) hint.textContent = 'Click a place to see it and track its events. Places with a ★ have a website.';
  } catch (e) {
    if (hint) hint.textContent = e.message;
  } finally {
    nb.loadingPlaces = false;
  }
  drawPlaces(nb.ctx);
}

function popupHtml(state, p) {
  const k = PLACE_KINDS[p.kind];
  const isTracked = p.website && trackedSites(state).has(siteKey(p.website));
  return `<div class="nb-pop">
    <b>${esc(p.name)}</b><br><span class="sub">${k.icon} ${esc(k.label)}${p.address ? ` · ${esc(p.address)}` : ''}</span>
    ${p.closed ? '<br><span class="sub" style="color:var(--danger)">Marked closed on the map</span>' : ''}
    <div class="ch-actions">
      ${
        p.website
          ? isTracked
            ? '<span class="sub">Tracking ✓</span>'
            : `<button class="primary small" data-action="nb-track" data-url="${esc(p.website)}" data-name="${esc(p.name)}">Track events</button>`
          : '<span class="sub">No website listed on the map</span>'
      }
      ${p.website ? `<a href="${esc(safeHref(p.website))}" target="_blank" rel="noopener">Website ↗</a>` : ''}
    </div></div>`;
}

// Markers are kept between redraws (so an open popup survives live data updates);
// only their style changes when a place becomes tracked.
function drawPlaces(ctx) {
  if (!nb.map || !nb.layer || !ctx) return;
  const tracked = trackedSites(ctx.state);
  nb.markers ||= new Map();
  for (const p of nb.places.values()) {
    let m = nb.markers.get(p.id);
    if (!nb.kinds.has(p.kind)) {
      if (m) nb.layer.removeLayer(m);
      continue;
    }
    const k = PLACE_KINDS[p.kind];
    const isTracked = !!p.website && tracked.has(siteKey(p.website));
    const style = {
      radius: p.website ? 7 : 5,
      weight: isTracked ? 3 : 1,
      color: isTracked ? '#1d4d35' : '#ffffff',
      fillColor: `hsl(${k.hue} 60% 50%)`,
      fillOpacity: p.website ? 0.95 : 0.55,
    };
    if (!m) {
      m = L.circleMarker([p.lat, p.lon], style);
      m.bindTooltip(`${k.icon} ${p.name}${p.website ? ' ★' : ''}`);
      m.bindPopup(() => popupHtml(nb.ctx.state, p));
      nb.markers.set(p.id, m);
    } else {
      m.setStyle(style);
    }
    if (!nb.layer.hasLayer(m)) m.addTo(nb.layer);
  }
}

// ---------- actions (called from main.js click/submit handlers) ----------

export async function handleNearbyAction(action, el, ctx) {
  const { store, rerender } = ctx;
  switch (action) {
    case 'nb-kind': {
      const k = el.dataset.kind;
      nb.kinds.has(k) ? nb.kinds.delete(k) : nb.kinds.add(k);
      savePref('nearbyKinds', [...nb.kinds]);
      renderKinds();
      drawPlaces(nb.ctx);
      return true;
    }
    case 'nb-track': {
      el.disabled = true;
      try {
        await store.addVenue(el.dataset.url, el.dataset.name || '');
        el.outerHTML = '<span class="sub">Tracking ✓ (events appear within the hour)</span>';
      } catch (e) {
        el.disabled = false;
        el.textContent = e.message.includes('already') ? 'Tracking ✓' : 'Couldn’t add';
      }
      return true;
    }
    case 'nb-focus':
      if (nb.map) {
        nb.map.setView([Number(el.dataset.lat), Number(el.dataset.lon)], 16);
        document.getElementById('nb-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return true;
    case 'nb-dismiss':
      nb.dismissed.add(el.dataset.id);
      savePref('dismissedSuggestions', [...nb.dismissed]);
      renderSuggestions(nb.ctx);
      return true;
    case 'nb-more':
      nb.showAllChanges = true;
      renderChanges(nb.ctx);
      return true;
    case 'nb-edit-area': {
      const b = savedBox(ctx.state);
      nb.draft = { box: { ...b }, label: ctx.state.profile?.homeLabel || '' };
      nb.formMsg = '';
      rerender();
      return true;
    }
    case 'nb-cancel-edit':
      nb.draft = null;
      nb.formMsg = '';
      nb.fitPending = true;
      rerender();
      return true;
    case 'nb-use-view':
      if (nb.map && nb.draft) {
        const v = nb.map.getBounds().pad(-0.05);
        nb.draft.box = { s: v.getSouth(), w: v.getWest(), n: v.getNorth(), e: v.getEast() };
        const fitted = normalizeBox(nb.draft.box);
        if (fitted && (fitted.n - fitted.s < v.getNorth() - v.getSouth() - 0.02 || fitted.e - fitted.w < v.getEast() - v.getWest() - 0.02)) {
          nb.formMsg = 'That view is bigger than an area can be (about 70 × 70 miles), so the box was trimmed to fit. Zoom in to choose more precisely.';
          nb.draft.box = fitted;
          nb.fitPending = true;
          rerender();
        } else {
          drawBox();
        }
      }
      return true;
    case 'nb-save-box': {
      if (!nb.draft) return true;
      nb.busy = true;
      rerender();
      try {
        await store.saveProfile({ homeLabel: nb.draft.label || 'My area', box: nb.draft.box });
        nb.draft = null;
        nb.formMsg = '';
        nb.suggestions = null;
        nb.fitPending = true;
      } catch (e) {
        nb.formMsg = '!' + e.message;
      } finally {
        nb.busy = false;
        rerender();
      }
      return true;
    }
    case 'nb-locate': {
      if (!navigator.geolocation) {
        nb.formMsg = '!This browser can’t share its location. Type your town instead.';
        rerender();
        return true;
      }
      nb.formMsg = 'Finding your location…';
      rerender();
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          let label = 'My area';
          try {
            const lat = pos.coords.latitude.toFixed(2);
            const lon = pos.coords.longitude.toFixed(2);
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`);
            const j = await r.json();
            const a = j.address || {};
            label = [a.city || a.town || a.village || a.county, a.state].filter(Boolean).join(', ') || label;
          } catch {
            /* keep generic label */
          }
          startDraft(pos.coords.latitude, pos.coords.longitude, label);
          rerender();
        },
        () => {
          nb.formMsg = '!Location permission was denied. Type your town instead.';
          rerender();
        },
        { timeout: 15000 },
      );
      return true;
    }
    default:
      return false;
  }
}

function startDraft(lat, lon, label) {
  nb.draft = { box: boxAround(lat, lon), label };
  nb.formMsg = '';
  nb.fitPending = true;
}

/** "Find" / "Go": look up a town and start (or move) the box there. */
export async function handleNearbySubmit(form, ctx) {
  if (form.dataset.action !== 'nb-find') return false;
  const { rerender } = ctx;
  const place = String(new FormData(form).get('place') || '').trim();
  if (!place) return true;
  nb.busy = true;
  nb.formMsg = 'Looking up that place…';
  rerender();
  try {
    const g = await geocode(place);
    startDraft(g.lat, g.lon, g.label);
  } catch (e) {
    nb.formMsg = '!' + e.message;
  } finally {
    nb.busy = false;
    rerender();
  }
  return true;
}

export async function handleNearbyChange(el, ctx) {
  if (el.dataset.action !== 'nb-suggest-toggle') return false;
  nb.suggestions = el.checked ? nb.suggestions : null;
  await ctx.store.saveProfile({ suggestions: el.checked });
  return true;
}
