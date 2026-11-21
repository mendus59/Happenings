// "Restaurants" tab: separate dine-in / takeout / delivery areas, restaurants with menus read from
// their own websites, per-mode favorite / disliked ratings, ordering links, filters, and new or
// closing restaurants. Restaurant lists come from the daily job (see scraper/src/restaurants).
import L from 'leaflet';
import { MODES, MODE_IDS, restaurantQuery, restaurantFromElement, deliverySearchLinks, priceLabel, openedOf } from '../../shared/restaurants.js';
import { fetchOverpass, PLACE_KINDS, RESTAURANT_KINDS } from '../../shared/places.js';
import { boxAround, boxCenter, distanceKm, inBox, normalizeBox, profileBox, areaFor } from '../../shared/geo.js';
import { createBoxEditor, toBounds, sizeText } from './boxEditor.js';
import { geocode } from './nearby.js';
import { esc, safeHref, loadPref, savePref, timeAgo } from './util.js';

const COLORS = { dine: '#2f6b4f', takeout: '#c26a1b', delivery: '#2f5fb3' };
const RATING_FILTERS = [
  ['any', 'Any'],
  ['fav', 'Favorites only'],
  ['nofav', 'Hide favorites'],
  ['dislike', 'Disliked only'],
  ['nodislike', 'Hide disliked'],
  ['unrated', 'Unrated only'],
];
const SORTS = [
  ['name', 'Name'],
  ['new', 'Newest first (date opened)'],
  ['fav', 'Favorites first'],
  ['price', 'Price: low to high'],
  ['near', 'Nearest to the middle of the area'],
];
const PAGE = 40;

const rs = {
  map: null,
  editors: {},
  layer: null,
  markers: new Map(),
  draft: null, // { boxes: {mode: box}, editing: mode, label }
  fitPending: false,
  formMsg: '',
  busy: false,
  limit: PAGE,
  showChanges: false,
  fallback: null, // { key, list, error } — map-only list shown before the first nightly update
  fallbackLoading: false,
  menuFor: null, // restaurant id whose menu dialog is open
  f: {
    q: '',
    mode: loadPref('rsMode', ''),
    cuisine: '',
    prices: new Set(loadPref('rsPrices', [])),
    withMenu: loadPref('rsWithMenu', false),
    confirmed: loadPref('rsConfirmed', false),
    ratings: { dine: 'any', takeout: 'any', delivery: 'any', ...loadPref('rsRatings', {}) },
    sort: loadPref('rsSort', 'name'),
    view: loadPref('rsView', 'list'),
  },
};

// ---------- data ----------

const boxesOf = (state) => Object.fromEntries(MODE_IDS.filter((m) => state.rBoxes.get(m)).map((m) => [m, state.rBoxes.get(m)]));
const hasBoxes = (state) => MODE_IDS.every((m) => state.rBoxes.get(m));

function unionBox(boxes) {
  const list = Object.values(boxes).filter(Boolean);
  if (!list.length) return null;
  return {
    s: Math.min(...list.map((b) => b.s)),
    w: Math.min(...list.map((b) => b.w)),
    n: Math.max(...list.map((b) => b.n)),
    e: Math.max(...list.map((b) => b.e)),
  };
}

/** Restaurants to show: the nightly list when there is one, else a map-only list fetched now. */
function allRestaurants(ctx) {
  const { state } = ctx;
  const boxes = boxesOf(state);
  const any = (r) => Object.values(boxes).some((b) => inBox(b, r));
  const nightly = [...state.restaurants.values()];
  const ready = [...state.rAreas.values()].some(Boolean);
  if (ready || nightly.length) return { list: nightly.filter(any), source: 'nightly' };
  loadFallback(ctx);
  return { list: (rs.fallback?.list || []).filter(any), source: 'map', loading: rs.fallbackLoading, error: rs.fallback?.error };
}

async function loadFallback(ctx) {
  const u = unionBox(boxesOf(ctx.state));
  if (!u) return;
  const area = areaFor(normalizeBox(u) || u);
  const key = area ? area.id : JSON.stringify(u);
  if (rs.fallbackLoading || rs.fallback?.key === key) return;
  rs.fallbackLoading = true;
  try {
    let cached = loadPref('rsMapCache', null);
    if (!cached || cached.key !== key || Date.now() - cached.at > 864e5) {
      const b = normalizeBox(u) || u;
      const json = await fetchOverpass(restaurantQuery(b, 60));
      const list = (json.elements || []).map(restaurantFromElement).filter(Boolean).map((r) => ({ ...r, m: [], price: 0, orderLinks: [] }));
      cached = { key, at: Date.now(), list };
      try {
        savePref('rsMapCache', cached);
      } catch {
        /* too big for storage; fine */
      }
    }
    rs.fallback = { key, list: cached.list };
  } catch (e) {
    rs.fallback = { key, list: [], error: e.userMessage || 'Couldn’t reach the map server. Try again in a minute.' };
  } finally {
    rs.fallbackLoading = false;
    ctx.rerender();
  }
}

const searchText = new WeakMap();
function textOf(r) {
  let t = searchText.get(r);
  if (!t) {
    t = [r.name, ...(r.cuisines || []), r.address].join(' ').toLowerCase();
    searchText.set(r, t);
  }
  return t;
}
const itemText = (i) => `${i.n} ${i.d || ''} ${i.s || ''}`.toLowerCase();

/** Filter + search. Returns [{r, dishes}] (dishes = menu items matching the search). */
function filtered(ctx, list) {
  const { state } = ctx;
  const f = rs.f;
  const tokens = f.q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const boxes = boxesOf(state);
  const out = [];
  for (const r of list) {
    if (f.mode) {
      if (!inBox(boxes[f.mode], r)) continue;
      if (r[f.mode] === false) continue;
      if (f.confirmed && r[f.mode] !== true) continue;
    }
    if (f.cuisine && !(r.cuisines || []).includes(f.cuisine)) continue;
    if (f.prices.size && !f.prices.has(r.price || 0)) continue;
    if (f.withMenu && !r.m?.length) continue;
    const rating = state.rRatings.get(r.id) || {};
    let ok = true;
    for (const m of MODE_IDS) {
      const want = f.ratings[m];
      const have = rating[m];
      if (want === 'any') continue;
      if ((want === 'fav' && have !== 'fav') || (want === 'nofav' && have === 'fav') || (want === 'dislike' && have !== 'dislike') || (want === 'nodislike' && have === 'dislike') || (want === 'unrated' && have)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let dishes = [];
    if (tokens.length) {
      const base = textOf(r);
      const items = r.m || [];
      dishes = items.filter((i) => tokens.every((t) => itemText(i).includes(t)));
      const all = base + ' ' + items.map(itemText).join(' ');
      if (!dishes.length && !tokens.every((t) => all.includes(t))) continue;
      if (!dishes.length && !tokens.every((t) => base.includes(t))) dishes = items.filter((i) => tokens.some((t) => itemText(i).includes(t)));
    }
    out.push({ r, dishes: dishes.slice(0, 4) });
  }
  const favCount = (r) => {
    const x = state.rRatings.get(r.id) || {};
    return f.mode ? (x[f.mode] === 'fav' ? 2 : 0) : MODE_IDS.filter((m) => x[m] === 'fav').length;
  };
  const mid = boxCenter(boxes[f.mode || 'dine'] || unionBox(boxes));
  const byName = (a, b) => a.r.name.localeCompare(b.r.name);
  const sorts = {
    name: byName,
    fav: (a, b) => favCount(b.r) - favCount(a.r) || byName(a, b),
    price: (a, b) => (a.r.price || 9) - (b.r.price || 9) || byName(a, b),
    near: (a, b) => distanceKm(mid, a.r) - distanceKm(mid, b.r),
    // Newest opening first; places with no known date after, by name.
    new: (a, b) => String(openedOf(b.r)?.date || '').localeCompare(String(openedOf(a.r)?.date || '')) || byName(a, b),
  };
  // Search results with matching dishes first.
  out.sort((a, b) => (tokens.length ? (b.dishes.length ? 1 : 0) - (a.dishes.length ? 1 : 0) : 0) || (sorts[f.sort] || byName)(a, b));
  return out;
}

// ---------- rendering ----------

export function renderRestaurants(ctx) {
  const { state, $app } = ctx;
  rs.ctx = ctx;
  const layout = rs.draft ? 'draft' : !hasBoxes(state) ? 'setup' : rs.f.view;
  if ($app.dataset.page !== 'restaurants' || $app.dataset.layout !== layout) {
    teardownMap();
    $app.dataset.page = 'restaurants';
    $app.dataset.layout = layout;
    $app.innerHTML = `<section class="restaurants">
      <div id="rs-head"></div>
      ${layout === 'draft' ? '<div id="rs-map" class="rs-map tall" role="region" aria-label="Map of your restaurant areas"></div>' : ''}
      ${layout === 'list' || layout === 'map' ? `<div id="rs-changes"></div><div id="rs-filters"></div><div id="rs-status" class="hint"></div>` : ''}
      ${layout === 'list' ? '<div id="rs-list" class="rs-list"></div>' : ''}
      ${layout === 'map' ? '<div id="rs-map" class="rs-map" role="region" aria-label="Map of restaurants"></div>' : ''}
    </section>`;
    if (layout === 'draft' || layout === 'map') setupMap(ctx);
    if (layout === 'list' || layout === 'map') {
      rs.filtersFor = allRestaurants(ctx).list.length;
      renderFilters(ctx);
    }
  }
  renderHead(ctx);
  if (layout === 'list' || layout === 'map') {
    // Refresh cuisine counts when new data arrives, unless the person is typing in the search box.
    const n = allRestaurants(ctx).list.length;
    if (rs.filtersFor !== n && document.activeElement?.dataset?.action !== 'rs-search') {
      rs.filtersFor = n;
      renderFilters(ctx);
    }
    renderChanges(ctx);
    renderResults(ctx);
  }
  if (rs.map) drawBoxes(ctx);
  renderMenuDialog(ctx);
}

export function leaveRestaurants($app) {
  if ($app.dataset.page !== 'restaurants') return;
  teardownMap();
  delete $app.dataset.page;
  delete $app.dataset.layout;
}

const msgHtml = () => (rs.formMsg ? `<div class="notice ${rs.formMsg.startsWith('!') ? 'error' : ''}">${esc(rs.formMsg.replace(/^!/, ''))}</div>` : '');

function renderHead(ctx) {
  const { state } = ctx;
  const el = document.getElementById('rs-head');
  if (!el) return;
  if (rs.draft) {
    const d = rs.draft;
    el.innerHTML = `<div class="nb-area-form editing">
      <div class="nb-area-title"><h2>Draw your restaurant areas</h2>
        <p class="hint">Each way of eating gets its own area. Pick one below, then drag its corners. Drag a small dot on an edge
          to add a corner, double-click (or long-press) a corner to remove it, and drag the ✥ to move it.
          Leave out places that are close on the map but slow to reach.</p></div>
      <form class="filter-row" data-action="rs-find">
        <input name="place" type="text" placeholder="Jump to a town" aria-label="Town or address">
        <button type="submit" ${rs.busy ? 'disabled' : ''}>Go</button>
      </form>
      <div class="rs-modes-edit" role="radiogroup" aria-label="Area to edit">
        ${MODE_IDS.map(
          (m) => `<button type="button" role="radio" aria-checked="${d.editing === m}" class="rs-mode-pick ${d.editing === m ? 'on' : ''}" style="--mode:${COLORS[m]}" data-action="rs-edit-mode" data-mode="${m}">
            <b>${MODES[m].icon} ${MODES[m].label}</b><span class="sub" id="rs-size-${m}">${esc(sizeText(d.boxes[m]))}</span>
            <span class="sub">${esc(MODES[m].boxHint)}</span></button>`,
        ).join('')}
      </div>
      <div class="filter-row">
        <button type="button" data-action="rs-use-view">Fit ${esc(MODES[d.editing].label.toLowerCase())} area to the map view</button>
        <button type="button" class="primary" data-action="rs-save-boxes" ${rs.busy ? 'disabled' : ''}>Save areas</button>
        ${hasBoxes(state) ? '<button type="button" class="link" data-action="rs-cancel">Cancel</button>' : ''}
      </div>
      ${msgHtml()}
    </div>`;
    return;
  }
  if (!hasBoxes(state)) {
    const home = profileBox(state.profile);
    el.innerHTML = `<div class="nb-area-form">
      <div class="nb-area-title"><h2>Restaurants near you</h2>
        <p class="hint">Set up three areas: where you’d go to <b>dine in</b>, where you’d pick up <b>takeout</b>, and where places could <b>deliver</b> to you.
          Then browse every restaurant inside them, search their menus for a dish, and mark favorites or dislikes for each way of eating.
          Menus and ordering links are read from each restaurant’s own website. Only the boxes are saved, never your address.</p></div>
      ${
        home
          ? `<div class="filter-row"><button class="primary" data-action="rs-start">Set up my areas around ${esc(state.profile.homeLabel || 'my home area')}</button></div>`
          : `<form class="filter-row" data-action="rs-find">
              <input name="place" type="text" placeholder="Your town, e.g. “Port Orchard, WA”" aria-label="Town or address" required>
              <button type="submit" class="primary" ${rs.busy ? 'disabled' : ''}>Start</button>
            </form>`
      }
      ${msgHtml()}
    </div>`;
    return;
  }
  el.innerHTML = `<div class="rs-head">
    <h2>Restaurants</h2>
    <div class="rs-areas">${MODE_IDS.map((m) => `<span class="rs-area" style="--mode:${COLORS[m]}">${MODES[m].icon} ${MODES[m].label} area</span>`).join('')}
      <button class="link" data-action="rs-edit">Change areas</button></div>
    <div class="seg" role="tablist" aria-label="View">
      <button role="tab" class="${rs.f.view === 'list' ? 'active' : ''}" aria-selected="${rs.f.view === 'list'}" data-action="rs-view" data-view="list">List</button>
      <button role="tab" class="${rs.f.view === 'map' ? 'active' : ''}" aria-selected="${rs.f.view === 'map'}" data-action="rs-view" data-view="map">Map</button>
    </div>
  </div>${msgHtml()}`;
}

function renderChanges(ctx) {
  const { state } = ctx;
  const el = document.getElementById('rs-changes');
  if (!el) return;
  const boxes = Object.values(boxesOf(state));
  const cutoff = Date.now() - 120 * 864e5;
  const list = state.areaChanges
    .filter((c) => RESTAURANT_KINDS.has(c.kind) && (c.lat == null || boxes.some((b) => inBox(b, c))))
    .filter((c) => (c.date ? Date.parse(c.date) : c.detectedAt?.getTime() || 0) >= cutoff)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  // Restaurants whose own website announces a closing.
  const closing = [...state.restaurants.values()].filter((r) => r.closure && boxes.some((b) => inBox(b, r)));
  const total = list.length + closing.length;
  const opens = list.filter((c) => c.change === 'opening').length;
  el.innerHTML = `<div class="rs-changes">
    <button class="rs-changes-toggle" data-action="rs-changes" aria-expanded="${rs.showChanges}">
      <b>New &amp; closing restaurants</b>
      <span class="sub">${total ? `${opens} opening · ${total - opens} closing in the last 4 months` : 'Nothing yet. Checked daily from Washington liquor-license notices and the map.'}</span>
      ${total ? `<span aria-hidden="true">${rs.showChanges ? '▴' : '▾'}</span>` : ''}
    </button>
    ${
      rs.showChanges && total
        ? `<ul class="changes">${closing
            .map(
              (r) => `<li class="change closing"><div class="ch-head"><span class="pill close">Closing?</span> <b>${esc(r.name)}</b></div>
                <div class="sub">Their website says: “${esc(r.closure.text.slice(0, 160))}”</div></li>`,
            )
            .join('')}${list
            .map((c) => {
              const k = PLACE_KINDS[c.kind] || PLACE_KINDS.restaurant;
              const q = `https://www.google.com/search?q=${encodeURIComponent(`${c.name} ${c.address || ''}`)}`;
              return `<li class="change ${c.change}">
                <div class="ch-head"><span class="pill ${c.change === 'opening' ? 'open' : 'close'}">${c.change === 'opening' ? 'Opening' : 'Closing'}</span> <b>${esc(c.name)}</b></div>
                <div class="sub">${k.icon} ${esc(k.label)}${c.address ? ` · ${esc(c.address)}` : ''}</div>
                <div class="sub">${esc(c.detail || '')}${c.date ? ` · ${esc(c.date)}` : ''}</div>
                <div class="ch-actions"><a href="${esc(q)}" target="_blank" rel="noopener">Look it up ↗</a></div>
              </li>`;
            })
            .join('')}</ul>`
        : ''
    }
  </div>`;
}

function renderFilters(ctx) {
  const el = document.getElementById('rs-filters');
  if (!el) return;
  const f = rs.f;
  const { list } = allRestaurants(ctx);
  const counts = new Map();
  for (const r of list) for (const c of r.cuisines || []) counts.set(c, (counts.get(c) || 0) + 1);
  const cuisines = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const ratingActive = MODE_IDS.filter((m) => f.ratings[m] !== 'any').length;
  el.innerHTML = `<div class="rs-filters">
    <div class="filter-row">
      <input type="search" placeholder="Search restaurants, cuisines or dishes (e.g. “pad thai”)" value="${esc(f.q)}" data-action="rs-search" aria-label="Search restaurants and menus">
      <select data-action="rs-sort" aria-label="Sort by">${SORTS.map(([id, l]) => `<option value="${id}" ${f.sort === id ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>
    </div>
    <div class="chips" role="group" aria-label="Way of eating">
      <button class="chip ${!f.mode ? 'on' : ''}" data-action="rs-mode" data-mode="" aria-pressed="${!f.mode}">All</button>
      ${MODE_IDS.map((m) => `<button class="chip ${f.mode === m ? 'on' : ''}" data-action="rs-mode" data-mode="${m}" aria-pressed="${f.mode === m}">${MODES[m].icon} ${MODES[m].label}</button>`).join('')}
      ${f.mode ? `<label class="toggle small"><input type="checkbox" data-action="rs-confirmed" ${f.confirmed ? 'checked' : ''}> Only places known to offer ${esc(MODES[f.mode].label.toLowerCase())}</label>` : ''}
    </div>
    <div class="filter-row">
      <select data-action="rs-cuisine" aria-label="Cuisine">
        <option value="">All cuisines</option>
        ${cuisines.map(([c, n]) => `<option value="${esc(c)}" ${f.cuisine === c ? 'selected' : ''}>${esc(c)} (${n})</option>`).join('')}
      </select>
      <div class="chips" role="group" aria-label="Price">
        ${[1, 2, 3, 4].map((p) => `<button class="chip ${f.prices.has(p) ? 'on' : ''}" data-action="rs-price" data-price="${p}" aria-pressed="${f.prices.has(p)}" title="Estimated from menu prices">${priceLabel(p)}</button>`).join('')}
        <button class="chip ${f.prices.has(0) ? 'on' : ''}" data-action="rs-price" data-price="0" aria-pressed="${f.prices.has(0)}" title="No prices found">Price unknown</button>
      </div>
      <label class="toggle small"><input type="checkbox" data-action="rs-withmenu" ${f.withMenu ? 'checked' : ''}> With a menu</label>
    </div>
    <details class="rs-ratings" ${ratingActive || rs.ratingsOpen ? 'open' : ''}>
      <summary data-action="rs-ratings-toggle">Favorites &amp; dislikes${ratingActive ? ` <span class="count">${ratingActive}</span>` : ''}</summary>
      <div class="filter-row">
        ${MODE_IDS.map(
          (m) => `<label class="rs-rating-filter">${MODES[m].icon} ${MODES[m].label}
            <select data-action="rs-rating" data-mode="${m}">${RATING_FILTERS.map(([id, l]) => `<option value="${id}" ${f.ratings[m] === id ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`,
        ).join('')}
        ${ratingActive ? '<button class="link" data-action="rs-clear-ratings">Clear</button>' : ''}
      </div>
    </details>
  </div>`;
}

const AVAIL = { true: ['yes', '✓'], false: ['no', '✗'], null: ['unknown', '?'] };

function modeRow(state, r, m, inside) {
  const rating = (state.rRatings.get(r.id) || {})[m];
  const [cls, mark] = AVAIL[String(r[m] ?? null)];
  const title = `${MODES[m].label}: ${cls === 'yes' ? 'offered' : cls === 'no' ? 'not offered' : 'not sure'}${inside ? '' : ' (outside your ' + MODES[m].label.toLowerCase() + ' area)'}`;
  return `<div class="rs-mode ${cls} ${inside ? '' : 'out'} ${rating ? 'rated-' + rating : ''}" title="${esc(title)}">
    <span class="rs-mode-label">${MODES[m].icon} ${MODES[m].label} <span class="mark" aria-label="${cls}">${mark}</span></span>
    <button class="rv-btn fav ${rating === 'fav' ? 'on' : ''}" data-action="rs-rate" data-id="${esc(r.id)}" data-mode="${m}" data-rating="fav" aria-pressed="${rating === 'fav'}" title="Favorite for ${MODES[m].label.toLowerCase()}">♥</button>
    <button class="rv-btn dislike ${rating === 'dislike' ? 'on' : ''}" data-action="rs-rate" data-id="${esc(r.id)}" data-mode="${m}" data-rating="dislike" aria-pressed="${rating === 'dislike'}" title="Disliked for ${MODES[m].label.toLowerCase()}">👎</button>
  </div>`;
}

function linksHtml(r) {
  const links = [];
  if (r.m?.length) links.push(`<button class="link" data-action="rs-menu" data-id="${esc(r.id)}">Menu (${r.m.length})</button>`);
  else if (r.menuUrl) links.push(`<a href="${esc(safeHref(r.menuUrl))}" target="_blank" rel="noopener">Menu ↗</a>`);
  if (r.website) links.push(`<a href="${esc(safeHref(r.website))}" target="_blank" rel="noopener">Website ↗</a>`);
  if (r.phone) links.push(`<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>`);
  const order = (r.orderLinks || []).map((o) => `<a class="order" href="${esc(safeHref(o.url))}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`);
  const have = new Set((r.orderLinks || []).map((o) => o.id));
  const search = r.delivery === false ? [] : deliverySearchLinks(r).filter((s) => !have.has(s.id)).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="Search ${esc(s.label)} for this restaurant">${esc(s.label)}</a>`);
  return `<div class="ch-actions">${links.join('')}</div>
    ${order.length ? `<div class="ch-actions rs-order"><span class="sub">Order:</span>${order.join('')}</div>` : ''}
    ${search.length ? `<div class="ch-actions rs-search-apps"><span>Look for it on</span>${search.join('<span aria-hidden="true">·</span>')}</div>` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-02" -> "Nov 2, 2026"; "2019-05" -> "May 2019"; "2015" -> "2015". */
function fmtDate(d) {
  const [y, m, day] = String(d).split('-');
  if (!m) return y;
  return day ? `${MONTHS[+m - 1]} ${+day}, ${y}` : `${MONTHS[+m - 1]} ${y}`;
}

/** Opening info line for a card, and whether it counts as new (last 4 months). */
function openedHtml(r) {
  const o = openedOf(r);
  if (!o) return { html: '', fresh: false };
  const days = (Date.now() - Date.parse(o.date.length === 4 ? `${o.date}-07-01` : o.date)) / 864e5;
  const fresh = days <= 120;
  const what =
    o.src === 'license'
      ? r.license.type === 'moved'
        ? 'Moved here (license notice)'
        : r.license.type === 'new-owner'
          ? 'New owner (license notice)'
          : 'New liquor license applied'
      : o.src === 'seen'
        ? 'First showed up on the map'
        : 'Opened';
  const title = o.src === 'license' ? r.license.detail : o.src === 'map' ? 'From the map’s recorded opening date' : 'The first day our nightly check found it on the map';
  return { html: `<div class="sub rs-opened" title="${esc(title)}">📅 ${what} ${esc(fmtDate(o.date))}</div>`, fresh };
}

function cardHtml(state, { r, dishes }, boxes) {
  const ratings = state.rRatings.get(r.id) || {};
  const unrated = !MODE_IDS.some((m) => ratings[m]);
  const meta = [(r.cuisines || []).join(', '), priceLabel(r.price), r.address].filter(Boolean).map(esc).join(' · ');
  const opened = openedHtml(r);
  return `<article class="rs-card ${unrated ? 'unrated' : ''}" data-id="${esc(r.id)}">
    <div class="rs-card-head">
      <h3>${esc(r.name)}</h3>
      ${unrated ? '<span class="pill new">Unrated</span>' : ''}
      ${opened.fresh ? '<span class="pill open">New</span>' : ''}
      ${r.fromLicense ? '<span class="pill soon" title="Known from a liquor-license notice; not on the map yet">Coming soon?</span>' : ''}
      ${r.closure ? '<span class="pill close" title="Their website mentions closing">Closing?</span>' : ''}
    </div>
    <div class="sub">${meta || esc(PLACE_KINDS[r.kind]?.label || 'Restaurant')}</div>
    ${opened.html}
    ${dishes.length ? `<div class="rs-dishes">${dishes.map((d) => `<span>${esc(d.n)}${d.p != null ? ` <b>$${d.p.toFixed(d.p % 1 ? 2 : 0)}</b>` : ''}</span>`).join('')}</div>` : ''}
    <div class="rs-modes">${MODE_IDS.map((m) => modeRow(state, r, m, inBox(boxes[m], r))).join('')}</div>
    ${linksHtml(r)}
  </article>`;
}

function renderResults(ctx) {
  const { state } = ctx;
  const all = allRestaurants(ctx);
  const results = filtered(ctx, all.list);
  const status = document.getElementById('rs-status');
  const areas = [...state.rAreas.values()].filter(Boolean);
  const updated = areas.map((a) => a.updatedAt).filter(Boolean).sort((a, b) => a - b)[0];
  const withMenu = all.list.filter((r) => r.m?.length).length;
  if (status) {
    status.innerHTML =
      all.source === 'map'
        ? all.loading
          ? 'Finding restaurants on the map…'
          : all.error
            ? esc(all.error)
            : `${results.length} of ${all.list.length} restaurants. This first list comes straight from the map; menus, prices and ordering links are added by tonight’s update.`
        : `${results.length} of ${all.list.length} restaurants · menus for ${withMenu} · updated ${esc(timeAgo(updated))}. Menus are read from each restaurant’s own website about once a month. A crossed-out way of eating means the place is outside that area.`;
  }
  const boxes = boxesOf(state);
  const listEl = document.getElementById('rs-list');
  if (listEl) {
    const shown = results.slice(0, rs.limit);
    listEl.innerHTML = shown.length
      ? shown.map((x) => cardHtml(state, x, boxes)).join('') +
        (results.length > shown.length ? `<button class="rs-more" data-action="rs-more">Show ${Math.min(PAGE, results.length - shown.length)} more</button>` : '')
      : all.list.length
        ? '<div class="empty">No restaurants match these filters.</div>'
        : '';
  }
  if (rs.map && rs.f.view === 'map') drawMarkers(ctx, results);
}

// ---------- menu dialog ----------

let $menu = null;
function renderMenuDialog(ctx) {
  if (!rs.menuFor) {
    if ($menu?.open) $menu.close();
    return;
  }
  const r = ctx.state.restaurants.get(rs.menuFor) || allRestaurants(ctx).list.find((x) => x.id === rs.menuFor);
  if (!r) return;
  if (!$menu) {
    $menu = document.createElement('dialog');
    $menu.id = 'menu-dialog';
    $menu.setAttribute('aria-label', 'Menu');
    document.body.append($menu);
    $menu.addEventListener('close', () => {
      rs.menuFor = null;
    });
    $menu.addEventListener('click', (e) => {
      if (e.target === $menu) $menu.close();
    });
    $menu.addEventListener('input', (e) => {
      if (e.target.dataset.action === 'rs-menu-search') filterMenu(e.target.value);
    });
  }
  if ($menu.dataset.id !== r.id) {
    $menu.dataset.id = r.id;
    const sections = [];
    for (const i of r.m || []) {
      const s = i.s || 'Menu';
      let sec = sections.find((x) => x.name === s);
      if (!sec) sections.push((sec = { name: s, items: [] }));
      sec.items.push(i);
    }
    const checked = r.menuCheckedAt ? new Date(r.menuCheckedAt).toLocaleDateString() : '';
    $menu.innerHTML = `<div class="dialog-body">
      <header class="dialog-head"><div><h2>${esc(r.name)}</h2><div class="sub">${esc([(r.cuisines || []).join(', '), priceLabel(r.price)].filter(Boolean).join(' · '))}</div></div>
        <button class="link" data-close aria-label="Close">✕</button></header>
      <input type="search" data-action="rs-menu-search" placeholder="Search this menu" aria-label="Search this menu">
      <div class="menu-sections">${sections
        .map(
          (s) => `<section class="menu-sec"><h3>${esc(s.name)}</h3><ul>${s.items
            .map((i) => `<li data-text="${esc(itemText(i))}"><div class="menu-line"><span>${esc(i.n)}</span>${i.p != null ? `<b>$${i.p.toFixed(i.p % 1 ? 2 : 0)}</b>` : ''}</div>${i.d ? `<div class="sub">${esc(i.d)}</div>` : ''}</li>`)
            .join('')}</ul></section>`,
        )
        .join('')}</div>
      <p class="hint">Read from <a href="${esc(safeHref(r.menuUrl || r.website))}" target="_blank" rel="noopener">their website</a>${checked ? ` on ${esc(checked)}` : ''}. Prices and dishes may have changed.</p>
      ${linksHtml(r)}
    </div>`;
    $menu.querySelector('[data-close]').addEventListener('click', () => $menu.close());
    if (rs.f.q) {
      const input = $menu.querySelector('[data-action=rs-menu-search]');
      input.value = rs.f.q;
      filterMenu(rs.f.q);
    }
  }
  if (!$menu.open) $menu.showModal();
}

function filterMenu(q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  for (const li of $menu.querySelectorAll('li[data-text]')) li.hidden = tokens.length > 0 && !tokens.every((t) => li.dataset.text.includes(t));
  for (const sec of $menu.querySelectorAll('.menu-sec')) sec.hidden = ![...sec.querySelectorAll('li')].some((li) => !li.hidden);
}

// ---------- map ----------

function setupMap(ctx) {
  const el = document.getElementById('rs-map');
  if (!el) return;
  const boxes = rs.draft ? rs.draft.boxes : boxesOf(ctx.state);
  const u = unionBox(boxes);
  rs.map = L.map(el, { scrollWheelZoom: true });
  if (u) rs.map.fitBounds(toBounds(u), { padding: [20, 20] });
  else rs.map.setView([47.6, -122.6], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(rs.map);
  rs.layer = L.layerGroup().addTo(rs.map);
  rs.fitPending = false;
}

function teardownMap() {
  rs.map?.remove();
  rs.map = null;
  rs.editors = {};
  rs.layer = null;
  rs.markers = new Map();
}

function drawBoxes(ctx) {
  const boxes = rs.draft ? rs.draft.boxes : boxesOf(ctx.state);
  // Draw the box being edited last so its handles sit on top.
  const order = [...MODE_IDS].sort((a, b) => (rs.draft?.editing === a) - (rs.draft?.editing === b));
  for (const m of order) {
    if (!boxes[m]) continue;
    const ed = (rs.editors[m] ||= createBoxEditor(rs.map, {
      color: COLORS[m],
      onChange: (b) => {
        if (!rs.draft) return;
        rs.draft.boxes[m] = b;
        const size = document.getElementById(`rs-size-${m}`);
        if (size) size.textContent = sizeText(normalizeBox(b) || b);
      },
    }));
    ed.set(boxes[m]).edit(rs.draft?.editing === m);
  }
  if (rs.fitPending) {
    rs.fitPending = false;
    const u = unionBox(boxes);
    if (u) rs.map.fitBounds(toBounds(u), { padding: [20, 20] });
  }
}

function drawMarkers(ctx, results) {
  const { state } = ctx;
  const keep = new Set(results.map((x) => x.r.id));
  for (const [id, m] of rs.markers) {
    if (!keep.has(id)) {
      rs.layer.removeLayer(m);
      rs.markers.delete(id);
    }
  }
  for (const { r } of results) {
    const rating = state.rRatings.get(r.id) || {};
    const mode = rs.f.mode;
    const fav = mode ? rating[mode] === 'fav' : MODE_IDS.some((m) => rating[m] === 'fav');
    const dis = mode ? rating[mode] === 'dislike' : MODE_IDS.some((m) => rating[m] === 'dislike') && !fav;
    const style = {
      radius: r.m?.length ? 7 : 5,
      weight: fav ? 3 : 1,
      color: fav ? '#c9971c' : '#ffffff',
      fillColor: dis ? '#9aa19c' : `hsl(${PLACE_KINDS[r.kind === 'cafe' ? 'cafe' : 'restaurant'].hue} 65% 48%)`,
      fillOpacity: 0.9,
    };
    let mk = rs.markers.get(r.id);
    if (!mk) {
      mk = L.circleMarker([r.lat, r.lon], style).addTo(rs.layer);
      mk.bindTooltip(r.name);
      mk.bindPopup(() => {
        const x = state.restaurants.get(r.id) || r;
        return `<div class="nb-pop rs-pop">${cardHtml(rs.ctx.state, { r: x, dishes: [] }, boxesOf(rs.ctx.state))}</div>`;
      }, { maxWidth: 340 });
      rs.markers.set(r.id, mk);
    } else mk.setStyle(style);
  }
}

// ---------- actions ----------

function startDraft(state, center, label) {
  const home = profileBox(state.profile);
  const c = center || (home ? boxCenter(home) : null);
  if (!c) return;
  const existing = boxesOf(state);
  rs.draft = {
    editing: 'dine',
    label,
    boxes: {
      dine: existing.dine || (home && !center ? { ...home } : boxAround(c.lat, c.lon, 25)),
      takeout: existing.takeout || boxAround(c.lat, c.lon, 10),
      delivery: existing.delivery || boxAround(c.lat, c.lon, 6),
    },
  };
  if (center) for (const [m, km] of [['dine', 25], ['takeout', 10], ['delivery', 6]]) rs.draft.boxes[m] = boxAround(c.lat, c.lon, km);
  rs.fitPending = true;
  rs.formMsg = '';
}

const savePrefs = () => {
  savePref('rsMode', rs.f.mode);
  savePref('rsPrices', [...rs.f.prices]);
  savePref('rsWithMenu', rs.f.withMenu);
  savePref('rsConfirmed', rs.f.confirmed);
  savePref('rsRatings', rs.f.ratings);
  savePref('rsSort', rs.f.sort);
  savePref('rsView', rs.f.view);
};

function refilter(ctx, { filters = true } = {}) {
  savePrefs();
  rs.limit = PAGE;
  if (filters) renderFilters(ctx);
  renderResults(ctx);
}

export async function handleRestaurantAction(action, el, ctx) {
  const { store, state, rerender } = ctx;
  switch (action) {
    case 'rs-start':
      startDraft(state, null, state.profile?.homeLabel);
      rerender();
      return true;
    case 'rs-edit':
      startDraft(state, null, '');
      rerender();
      return true;
    case 'rs-cancel':
      rs.draft = null;
      rs.formMsg = '';
      rerender();
      return true;
    case 'rs-edit-mode':
      rs.draft.editing = el.dataset.mode;
      renderHead(ctx);
      drawBoxes(ctx);
      return true;
    case 'rs-use-view':
      if (rs.map && rs.draft) {
        const v = rs.map.getBounds().pad(-0.05);
        rs.draft.boxes[rs.draft.editing] = normalizeBox({ s: v.getSouth(), w: v.getWest(), n: v.getNorth(), e: v.getEast() }) || rs.draft.boxes[rs.draft.editing];
        drawBoxes(ctx);
        renderHead(ctx);
      }
      return true;
    case 'rs-save-boxes':
      rs.busy = true;
      renderHead(ctx);
      try {
        await store.saveRestaurantBoxes(rs.draft.boxes);
        rs.draft = null;
        rs.formMsg = '';
        rs.fallback = null;
      } catch (e) {
        rs.formMsg = '!' + e.message;
      } finally {
        rs.busy = false;
        rerender();
      }
      return true;
    case 'rs-view':
      rs.f.view = el.dataset.view;
      savePrefs();
      rerender();
      return true;
    case 'rs-mode':
      rs.f.mode = el.dataset.mode;
      refilter(ctx);
      return true;
    case 'rs-price': {
      const p = Number(el.dataset.price);
      rs.f.prices.has(p) ? rs.f.prices.delete(p) : rs.f.prices.add(p);
      refilter(ctx);
      return true;
    }
    case 'rs-clear-ratings':
      rs.f.ratings = { dine: 'any', takeout: 'any', delivery: 'any' };
      refilter(ctx);
      return true;
    case 'rs-ratings-toggle':
      rs.ratingsOpen = !el.parentElement.open; // the click fires before the details element toggles
      return true;
    case 'rs-changes':
      rs.showChanges = !rs.showChanges;
      renderChanges(ctx);
      return true;
    case 'rs-more':
      rs.limit += PAGE;
      renderResults(ctx);
      return true;
    case 'rs-menu':
      rs.menuFor = el.dataset.id;
      renderMenuDialog(ctx);
      return true;
    case 'rs-rate': {
      const r = state.restaurants.get(el.dataset.id) || allRestaurants(ctx).list.find((x) => x.id === el.dataset.id);
      if (r) await store.rateRestaurant(r, el.dataset.mode, el.dataset.rating);
      return true;
    }
    default:
      return false;
  }
}

export async function handleRestaurantSubmit(form, ctx) {
  if (form.dataset.action !== 'rs-find') return false;
  const place = String(new FormData(form).get('place') || '').trim();
  if (!place) return true;
  rs.busy = true;
  rs.formMsg = 'Looking up that place…';
  renderHead(ctx);
  try {
    const g = await geocode(place);
    startDraft(ctx.state, { lat: g.lat, lon: g.lon }, g.label);
  } catch (e) {
    rs.formMsg = '!' + e.message;
  } finally {
    rs.busy = false;
    ctx.rerender();
  }
  return true;
}

export function handleRestaurantChange(el, ctx) {
  const a = el.dataset.action;
  if (a === 'rs-sort') rs.f.sort = el.value;
  else if (a === 'rs-cuisine') rs.f.cuisine = el.value;
  else if (a === 'rs-withmenu') rs.f.withMenu = el.checked;
  else if (a === 'rs-confirmed') rs.f.confirmed = el.checked;
  else if (a === 'rs-rating') rs.f.ratings[el.dataset.mode] = el.value;
  else return false;
  refilter(ctx, { filters: a === 'rs-rating' || a === 'rs-confirmed' });
  return true;
}

let searchTimer;
export function handleRestaurantInput(el, ctx) {
  if (el.dataset.action !== 'rs-search') return false;
  rs.f.q = el.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refilter(ctx, { filters: false }), 150);
  return true;
}
