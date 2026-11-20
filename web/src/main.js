import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import { auth } from './firebase.js';
import { createStore } from './store.js';
import { renderNearby, leaveNearby, handleNearbyAction, handleNearbySubmit, handleNearbyChange } from './nearby.js';
import { CATEGORY_INFO, categoryInfo } from '../../shared/categories.js';
import {
  esc,
  safeHref,
  dayKey,
  dayKeyOf,
  todayKey,
  formatDayHeading,
  formatTimeRange,
  formatWhen,
  timeAgo,
  endsAt,
  downloadIcs,
  loadPref,
  savePref,
} from './util.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $user = document.getElementById('user');
const $dialog = document.getElementById('event-dialog');

const ui = {
  view: loadPref('view', 'list'), // list | calendar | venues | nearby
  status: loadPref('status', 'active'), // review | active | interested | favorite | hidden
  categories: new Set(loadPref('categories', [])),
  venue: loadPref('venue', ''),
  sort: loadPref('sort', 'date'),
  search: '',
  month: null, // Date of first day of the calendar month shown
  authMode: 'signin',
  authError: '',
  venueError: '',
  busy: false,
};

let store = null;
let user = null;
let openEventKey = null;

// ---------- derived data ----------

function venueLabel(state, venueId, ev) {
  const sub = state.subscriptions.get(venueId);
  const venue = state.venues.get(venueId);
  if (sub?.label) return sub.label;
  if (venue?.name) return venue.name;
  if (ev?.venueName) return ev.venueName;
  try {
    return new URL(sub?.url).hostname.replace(/^www\./, '');
  } catch {
    return 'Venue';
  }
}

function allEvents(state) {
  const out = [];
  for (const [venueId, events] of state.events) {
    if (!state.subscriptions.has(venueId)) continue;
    for (const ev of events.values()) {
      if (!ev.start) continue;
      const review = state.reviews.get(ev.key) || null;
      // Removed events are only worth showing if the user cared about them.
      if (ev.removed && review !== 'interested' && review !== 'favorite') continue;
      out.push({ ...ev, review, venueLabel: venueLabel(state, venueId, ev) });
    }
  }
  return out;
}

function matchesStatus(ev) {
  switch (ui.status) {
    case 'review':
      return !ev.review && !ev.removed;
    case 'interested':
      return ev.review === 'interested' || ev.review === 'favorite';
    case 'favorite':
      return ev.review === 'favorite';
    case 'hidden':
      return ev.review === 'hidden';
    default:
      return ev.review !== 'hidden';
  }
}

function filtered(events, { includePast = false } = {}) {
  const now = Date.now();
  const q = ui.search.trim().toLowerCase();
  return events.filter((ev) => {
    if (!includePast && endsAt(ev).getTime() < now) return false;
    if (!matchesStatus(ev)) return false;
    if (ui.categories.size && !ui.categories.has(ev.category)) return false;
    if (ui.venue && ev.venueId !== ui.venue) return false;
    if (q && !`${ev.title} ${ev.venueLabel} ${ev.description} ${ev.location}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function sorted(events) {
  const byDate = (a, b) => a.start - b.start;
  if (ui.sort === 'type') {
    return events.sort((a, b) => categoryInfo(a.category).label.localeCompare(categoryInfo(b.category).label) || byDate(a, b));
  }
  if (ui.sort === 'venue') return events.sort((a, b) => a.venueLabel.localeCompare(b.venueLabel) || byDate(a, b));
  return events.sort(byDate);
}

// ---------- rendering ----------

function render() {
  if (!user || ui.view !== 'nearby' || store?.state.error || store?.state.loading) leaveNearby($app);
  if (!user) return renderAuth();
  const state = store.state;
  const events = allEvents(state);
  const upcoming = events.filter((e) => endsAt(e).getTime() >= Date.now());
  const toReview = upcoming.filter((e) => !e.review && !e.removed).length;

  $nav.hidden = false;
  $nav.innerHTML = [
    ['list', 'Events'],
    ['calendar', 'Calendar'],
    ['venues', 'Venues'],
    ['nearby', 'Nearby'],
  ]
    .map(
      ([id, label]) =>
        `<button class="tab ${ui.view === id ? 'active' : ''}" data-action="view" data-view="${id}" aria-current="${ui.view === id ? 'page' : 'false'}">${label}${
          id === 'list' && toReview ? ` <span class="count">${toReview}</span>` : ''
        }</button>`,
    )
    .join('');
  $user.innerHTML = `<span class="who">${esc(user.displayName || user.email || '')}</span><button class="link" data-action="signout">Sign out</button>`;

  if (state.error) {
    $app.innerHTML = `<div class="notice error">Something went wrong loading your data: ${esc(state.error)}</div>`;
    return;
  }
  if (state.loading) {
    $app.innerHTML = `<div class="empty">Loading…</div>`;
    return;
  }
  if (ui.view === 'nearby') return renderNearby({ state, store, $app, rerender: render });
  if (ui.view === 'venues' || state.subscriptions.size === 0) return renderVenues(state);
  if (ui.view === 'calendar') return renderCalendar(state, events);
  return renderList(state, events, toReview);
}

function filterBar(state, events) {
  const present = new Set(events.map((e) => e.category));
  const cats = Object.entries(CATEGORY_INFO).filter(([id]) => present.has(id) || ui.categories.has(id));
  const statuses = [
    ['review', 'To review'],
    ['active', 'All'],
    ['interested', 'Interested'],
    ['favorite', 'Favorites'],
    ['hidden', 'Hidden'],
  ];
  const venues = [...state.subscriptions.keys()].map((id) => [id, venueLabel(state, id)]).sort((a, b) => a[1].localeCompare(b[1]));
  return `
    <div class="filters">
      <div class="segmented" role="group" aria-label="Review status">
        ${statuses
          .map(([id, label]) => `<button class="${ui.status === id ? 'active' : ''}" data-action="status" data-status="${id}">${label}</button>`)
          .join('')}
      </div>
      <div class="filter-row">
        <input type="search" placeholder="Search events" value="${esc(ui.search)}" data-action="search" aria-label="Search events">
        <select data-action="venue" aria-label="Venue">
          <option value="">All venues</option>
          ${venues.map(([id, label]) => `<option value="${id}" ${ui.venue === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        ${
          ui.view === 'list'
            ? `<select data-action="sort" aria-label="Sort by">
                <option value="date" ${ui.sort === 'date' ? 'selected' : ''}>Sort: Date</option>
                <option value="type" ${ui.sort === 'type' ? 'selected' : ''}>Sort: Type</option>
                <option value="venue" ${ui.sort === 'venue' ? 'selected' : ''}>Sort: Venue</option>
              </select>`
            : ''
        }
      </div>
      ${
        cats.length
          ? `<div class="chips" role="group" aria-label="Event types">
              ${cats
                .map(
                  ([id, c]) =>
                    `<button class="chip ${ui.categories.has(id) ? 'on' : ''}" style="--hue:${c.hue}" data-action="category" data-category="${id}" aria-pressed="${ui.categories.has(id)}">${c.icon} ${esc(c.label)}</button>`,
                )
                .join('')}
              ${ui.categories.size ? `<button class="link" data-action="clear-categories">Clear</button>` : ''}
            </div>`
          : ''
      }
    </div>`;
}

function reviewButtons(ev, compact = false) {
  const btn = (state, icon, label) =>
    `<button type="button" class="rv rv-${state} ${ev.review === state ? 'on' : ''}" data-action="review" data-key="${esc(ev.key)}" data-state="${state}" aria-pressed="${ev.review === state}" title="${label}">${icon}${compact ? '' : `<span>${label}</span>`}</button>`;
  return `<div class="review">${btn('interested', '✓', 'Interested')}${btn('favorite', '★', 'Favorite')}${btn('hidden', '✕', 'Hide')}</div>`;
}

function eventCard(ev) {
  const c = categoryInfo(ev.category);
  const isNew = !ev.review && !ev.removed;
  return `
    <article class="card ${isNew ? 'unreviewed' : ''} ${ev.review ? 'rv-' + ev.review : ''} ${ev.removed ? 'removed' : ''}" style="--hue:${c.hue}">
      <button class="card-main" data-action="open" data-key="${esc(ev.key)}">
        <div class="time">${esc(formatTimeRange(ev))}</div>
        <div class="body">
          <h3>${isNew ? '<span class="pill new">New</span> ' : ''}${ev.review === 'favorite' ? '<span class="fav" aria-label="Favorite">★</span> ' : ''}${esc(ev.title)}</h3>
          <div class="meta">
            <span class="badge">${c.icon} ${esc(c.label)}</span>
            <span>${esc(ev.venueLabel)}</span>
            ${ev.price ? `<span>${esc(ev.price)}</span>` : ''}
          </div>
          ${ev.removed ? `<div class="removed-note">The venue removed this from their calendar. It may be cancelled or rescheduled.</div>` : ''}
        </div>
      </button>
      ${reviewButtons(ev, true)}
    </article>`;
}

function renderList(state, events, toReview) {
  const list = sorted(filtered(events));
  let body = '';
  if (!list.length) {
    const msg =
      ui.status === 'review'
        ? "You're all caught up. Nothing new to review."
        : events.length
          ? 'No events match these filters.'
          : 'No upcoming events yet. New venues are checked within about an hour.';
    body = `<div class="empty">${msg}</div>`;
  } else if (ui.sort === 'date') {
    let lastDay = '';
    for (const ev of list) {
      const k = dayKey(ev);
      if (k !== lastDay) {
        if (lastDay) body += '</section>';
        body += `<section class="day"><h2>${esc(formatDayHeading(k))}</h2>`;
        lastDay = k;
      }
      body += eventCard(ev);
    }
    body += '</section>';
  } else {
    body = `<section class="day">${list
      .map((ev) => eventCard(ev).replace('<div class="time">', `<div class="time"><b>${esc(formatDayHeading(dayKey(ev)).replace(/^(Today|Tomorrow) · /, ''))}</b><br>`))
      .join('')}</section>`;
  }
  const banner =
    toReview && ui.status !== 'review'
      ? `<div class="notice review-banner"><span><b>${toReview}</b> new event${toReview === 1 ? '' : 's'} to review.</span><button class="primary" data-action="status" data-status="review">Review now</button></div>`
      : '';
  $app.innerHTML = `${banner}${filterBar(state, events)}<div class="list">${body}</div>`;
}

function renderCalendar(state, events) {
  if (!ui.month) {
    const n = new Date();
    ui.month = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  const m = ui.month;
  const list = filtered(events, { includePast: true });
  const byDay = new Map();
  for (const ev of list) {
    const k = dayKey(ev);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(ev);
  }
  for (const evs of byDay.values()) evs.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));

  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const today = todayKey();
  const weekdays = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 7 + i)));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m.getMonth()) break;
    const k = dayKeyOf(d);
    const evs = byDay.get(k) || [];
    const inMonth = d.getMonth() === m.getMonth();
    cells += `<div class="cell ${inMonth ? '' : 'out'} ${k === today ? 'today' : ''} ${k < today ? 'past' : ''}">
      <div class="date">${d.getDate()}</div>
      ${evs
        .map((ev) => {
          const c = categoryInfo(ev.category);
          const isNew = !ev.review && !ev.removed;
          return `<button class="cal-ev ${isNew ? 'unreviewed' : ''} ${ev.review ? 'rv-' + ev.review : ''} ${ev.removed ? 'removed' : ''}" style="--hue:${c.hue}" data-action="open" data-key="${esc(ev.key)}" title="${esc(ev.title)} · ${esc(ev.venueLabel)}">
            ${ev.review === 'favorite' ? '★ ' : ''}<span class="t">${ev.allDay ? '' : esc(formatTimeRange(ev).split(' – ')[0])}</span> ${esc(ev.title)}
          </button>`;
        })
        .join('')}
    </div>`;
  }
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(m);
  $app.innerHTML = `${filterBar(state, events)}
    <div class="cal-head">
      <button data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
      <h2>${esc(title)}</h2>
      <button data-action="month" data-delta="1" aria-label="Next month">›</button>
      <button class="link" data-action="month" data-delta="0">Today</button>
    </div>
    <div class="calendar">
      ${weekdays.map((w) => `<div class="wd">${esc(w)}</div>`).join('')}
      ${cells}
    </div>
    <p class="hint">Highlighted events are new. Click one to review it.</p>`;
}

function venueStatus(venue) {
  if (!venue) return `<span class="status pending">Waiting for first check (usually within an hour)</span>`;
  const when = timeAgo(venue.lastScrapedAt?.toDate?.());
  if (venue.status === 'error') {
    const blocked = /HTTP (401|403|429)/.test(venue.error || '');
    return blocked
      ? `<span class="status error">This website blocks automated visitors, so Happenings can't read it. Checked ${when}.</span>`
      : `<span class="status error">Couldn't read this page (${esc(venue.error || 'error')}). Checked ${when}.</span>`;
  }
  if (venue.status === 'empty') return `<span class="status warn">No events found on this page. Checked ${when}.</span>`;
  return `<span class="status ok">${venue.eventCount ?? 0} upcoming events · checked ${when}</span>`;
}

function renderVenues(state) {
  const subs = [...state.subscriptions.values()].sort((a, b) => venueLabel(state, a.id).localeCompare(venueLabel(state, b.id)));
  $app.innerHTML = `
    <section class="venues">
      <h2>Your venues</h2>
      <p class="hint">Add the events or calendar page of any business or venue. Happenings checks it every few hours and adds new events to your calendar.</p>
      <form class="add-venue" data-action="add-venue">
        <input name="url" type="text" inputmode="url" placeholder="https://www.example.com/events" required aria-label="Events page address">
        <input name="label" type="text" placeholder="Name (optional)" aria-label="Venue name">
        <button class="primary" type="submit" ${ui.busy ? 'disabled' : ''}>Add venue</button>
      </form>
      ${ui.venueError ? `<div class="notice error">${esc(ui.venueError)}</div>` : ''}
      ${
        subs.length
          ? `<ul class="venue-list">${subs
              .map((s) => {
                const v = state.venues.get(s.id);
                const page = v?.eventsPageUrl && v.eventsPageUrl !== s.url ? `<div class="sub">Events found on <a href="${esc(safeHref(v.eventsPageUrl))}" target="_blank" rel="noopener">${esc(v.eventsPageUrl)}</a></div>` : '';
                return `<li>
                  <div class="vinfo">
                    <div class="vname">${esc(venueLabel(state, s.id))}</div>
                    <a class="sub" href="${esc(safeHref(s.url))}" target="_blank" rel="noopener">${esc(s.url)}</a>
                    ${page}
                    ${venueStatus(v)}
                  </div>
                  <div class="vactions">
                    <button data-action="rename-venue" data-id="${s.id}">Rename</button>
                    <button data-action="rescan" data-id="${s.id}" title="Ask for this page to be checked on the next run">Check again</button>
                    <button class="danger" data-action="remove-venue" data-id="${s.id}">Remove</button>
                  </div>
                </li>`;
              })
              .join('')}</ul>`
          : `<div class="empty">You haven't added any venues yet. Paste the events or calendar page of a local business above to get started.</div>`
      }
    </section>`;
}

function renderDialog() {
  if (!openEventKey) return;
  const ev = allEvents(store.state).find((e) => e.key === openEventKey) || null;
  if (!ev) {
    $dialog.close();
    return;
  }
  const c = categoryInfo(ev.category);
  const tags = (ev.tags || []).filter((t) => t !== ev.category && CATEGORY_INFO[t]);
  $dialog.innerHTML = `
    <form method="dialog" class="dlg" style="--hue:${c.hue}">
      <button class="close" value="close" aria-label="Close">✕</button>
      ${ev.image ? `<img class="hero" src="${esc(safeHref(ev.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="dlg-body">
        <div class="meta"><span class="badge">${c.icon} ${esc(c.label)}</span>${tags.map((t) => `<span class="badge soft">${esc(CATEGORY_INFO[t].label)}</span>`).join('')}</div>
        <h2>${esc(ev.title)}</h2>
        <p class="when">${esc(formatWhen(ev))}</p>
        <p class="where">${esc(ev.venueLabel)}${ev.location && !ev.location.startsWith(ev.venueLabel) ? ` · ${esc(ev.location)}` : ''}</p>
        ${ev.price ? `<p class="price">${esc(ev.price)}</p>` : ''}
        ${ev.removed ? `<div class="removed-note">The venue removed this from their calendar. It may be cancelled or rescheduled.</div>` : ''}
        ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
        ${reviewButtons(ev)}
        <div class="links">
          <a href="${esc(safeHref(ev.url))}" target="_blank" rel="noopener">View on venue site ↗</a>
          <button type="button" class="link" data-action="ics" data-key="${esc(ev.key)}">Add to my calendar app</button>
        </div>
      </div>
    </form>`;
}

function renderAuth() {
  $nav.hidden = true;
  $user.innerHTML = '';
  const signup = ui.authMode === 'signup';
  $app.innerHTML = `
    <section class="auth">
      <h1>Never miss what's happening nearby.</h1>
      <p>Save the event pages of the local businesses and venues you love. Happenings gathers all their events into one calendar and tells you what's new.</p>
      <div class="auth-box">
        <button class="google" data-action="google">Continue with Google</button>
        <div class="or"><span>or</span></div>
        <form data-action="email-auth">
          <input name="email" type="email" autocomplete="email" placeholder="Email" required aria-label="Email">
          <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="Password${signup ? ' (6+ characters)' : ''}" required minlength="6" aria-label="Password">
          <button class="primary" type="submit" ${ui.busy ? 'disabled' : ''}>${signup ? 'Create account' : 'Sign in'}</button>
        </form>
        ${ui.authError ? `<div class="notice error">${esc(ui.authError)}</div>` : ''}
        <div class="auth-links">
          <button class="link" data-action="auth-mode">${signup ? 'Have an account? Sign in' : 'New here? Create an account'}</button>
          ${signup ? '' : '<button class="link" data-action="reset">Forgot password?</button>'}
        </div>
      </div>
    </section>`;
}

// ---------- events ----------

function friendlyAuthError(e) {
  const code = e?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'That email and password don’t match.';
  if (code.includes('email-already-in-use')) return 'An account with that email already exists. Try signing in.';
  if (code.includes('weak-password')) return 'Please choose a password with at least 6 characters.';
  if (code.includes('popup-closed')) return '';
  if (code.includes('unauthorized-domain')) return 'This site’s address isn’t authorized in Firebase yet (Authentication → Settings → Authorized domains).';
  if (code.includes('operation-not-allowed')) return 'This sign-in method isn’t turned on in Firebase yet.';
  return e?.message || 'Sign-in failed.';
}

function setPref(key, value) {
  ui[key] = value;
  savePref(key, value instanceof Set ? [...value] : value);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const a = el.dataset.action;
  try {
    if (a.startsWith('nb-')) {
      await handleNearbyAction(a, el, { state: store.state, store, $app, rerender: render });
      return;
    }
    switch (a) {
      case 'view':
        setPref('view', el.dataset.view);
        break;
      case 'status':
        setPref('status', el.dataset.status);
        if (ui.view === 'venues') setPref('view', 'list');
        break;
      case 'category': {
        const c = el.dataset.category;
        ui.categories.has(c) ? ui.categories.delete(c) : ui.categories.add(c);
        setPref('categories', ui.categories);
        break;
      }
      case 'clear-categories':
        setPref('categories', new Set());
        break;
      case 'month': {
        const d = Number(el.dataset.delta);
        const n = new Date();
        ui.month = d === 0 ? new Date(n.getFullYear(), n.getMonth(), 1) : new Date(ui.month.getFullYear(), ui.month.getMonth() + d, 1);
        break;
      }
      case 'open':
        openEventKey = el.dataset.key;
        renderDialog();
        if (!$dialog.open) $dialog.showModal();
        return;
      case 'review': {
        e.preventDefault();
        const ev = allEvents(store.state).find((x) => x.key === el.dataset.key);
        if (ev) await store.setReview(ev, el.dataset.state);
        return;
      }
      case 'ics': {
        const ev = allEvents(store.state).find((x) => x.key === el.dataset.key);
        if (ev) downloadIcs(ev);
        return;
      }
      case 'rescan':
        await store.rescanVenue(el.dataset.id);
        el.textContent = 'Queued ✓';
        el.disabled = true;
        return;
      case 'rename-venue': {
        const sub = store.state.subscriptions.get(el.dataset.id);
        const name = prompt('Name for this venue', sub?.label || venueLabel(store.state, el.dataset.id));
        if (name != null) await store.renameVenue(el.dataset.id, name);
        return;
      }
      case 'remove-venue':
        if (confirm(`Stop following ${venueLabel(store.state, el.dataset.id)}? Its events will disappear from your calendar.`)) {
          await store.removeVenue(el.dataset.id);
        }
        return;
      case 'signout':
        await signOut(auth);
        return;
      case 'google':
        ui.authError = '';
        await signInWithPopup(auth, new GoogleAuthProvider());
        return;
      case 'auth-mode':
        ui.authMode = ui.authMode === 'signup' ? 'signin' : 'signup';
        ui.authError = '';
        break;
      case 'reset': {
        const email = document.querySelector('[data-action=email-auth] input[name=email]')?.value.trim();
        if (!email) {
          ui.authError = 'Type your email above first, then click “Forgot password?”.';
        } else {
          await sendPasswordResetEmail(auth, email);
          ui.authError = `If an account exists for ${email}, a reset link is on its way.`;
        }
        break;
      }
      default:
        return;
    }
  } catch (err) {
    if (!user) ui.authError = friendlyAuthError(err);
    else alert(err.message || String(err));
  }
  render();
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const a = form.dataset.action;
  if (!a) return;
  e.preventDefault();
  if (a.startsWith('nb-')) {
    await handleNearbySubmit(form, { state: store.state, store, $app, rerender: render });
    return;
  }
  const data = new FormData(form);
  ui.busy = true;
  try {
    if (a === 'email-auth') {
      ui.authError = '';
      render();
      const email = String(data.get('email')).trim();
      const password = String(data.get('password'));
      if (ui.authMode === 'signup') await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
    } else if (a === 'add-venue') {
      ui.venueError = '';
      await store.addVenue(String(data.get('url')), String(data.get('label') || ''));
      form.reset();
    }
  } catch (err) {
    if (a === 'email-auth') ui.authError = friendlyAuthError(err);
    else ui.venueError = err.message || String(err);
  } finally {
    ui.busy = false;
    render();
  }
});

document.addEventListener('change', (e) => {
  const a = e.target.dataset?.action;
  if (a?.startsWith('nb-')) {
    handleNearbyChange(e.target, { state: store.state, store, $app, rerender: render }).catch((err) => alert(err.message));
    return;
  }
  if (a === 'venue') setPref('venue', e.target.value);
  else if (a === 'sort') setPref('sort', e.target.value);
  else return;
  render();
});

let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.dataset?.action !== 'search') return;
  ui.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const pos = e.target.selectionStart;
    render();
    const input = document.querySelector('[data-action=search]');
    input?.focus();
    input?.setSelectionRange(pos, pos);
  }, 150);
});

$dialog.addEventListener('close', () => {
  openEventKey = null;
});
$dialog.addEventListener('click', (e) => {
  if (e.target === $dialog) $dialog.close(); // backdrop click
});

// Refresh relative times / past-event cutoffs every few minutes.
setInterval(() => user && !$dialog.open && render(), 5 * 60 * 1000);

onAuthStateChanged(auth, (u) => {
  store?.stop();
  store = null;
  user = u;
  if (u) {
    store = createStore(u.uid, () => {
      render();
      renderDialog();
    });
  }
  render();
});
