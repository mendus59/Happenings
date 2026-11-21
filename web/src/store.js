// Live data: the user's saved venues, those venues' events, and the user's review states.
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  setDoc,
  deleteDoc,
  serverTimestamp,
  deleteField,
  Timestamp,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { normalizeVenueUrl, venueIdFor } from '../../shared/url.js';
import { flatPoints, normalizeBox, profileBox, storedBox } from '../../shared/geo.js';
import { areasForBoxes, MODE_IDS, RATINGS } from '../../shared/restaurants.js';

export const REVIEW_STATES = ['interested', 'favorite', 'hidden'];

export function createStore(uid, onChange) {
  const state = {
    loading: true,
    subscriptions: new Map(), // venueId -> {url, label, addedAt, scanRequestedAt}
    venues: new Map(), // venueId -> venue doc
    events: new Map(), // venueId -> Map(eventId -> event)
    reviews: new Map(), // `${venueId}__${eventId}` -> state
    profile: null, // { homeLabel, boxS, boxW, boxN, boxE, suggestions }
    areaChanges: [], // openings & closings across the user's home and restaurant areas
    rBoxes: new Map(), // mode -> {s,w,n,e}
    rRatings: new Map(), // restaurantId -> {dine, takeout, delivery}
    rAreas: new Map(), // areaId -> area doc (null until the job has filled it)
    restaurants: new Map(), // restaurantId -> restaurant (merged across areas)
    rLoaded: false,
    error: null,
  };
  const venueUnsubs = new Map();
  let pending = 5;
  // Openings & closings: one listener per shared area.
  const changeUnsubs = new Map(); // areaId -> unsub
  const changesByArea = new Map(); // areaId -> list
  function mergeChanges() {
    const byId = new Map();
    for (const list of changesByArea.values()) for (const c of list) byId.set(c.id, c);
    state.areaChanges = [...byId.values()].sort((a, b) => (b.detectedAt?.getTime() || 0) - (a.detectedAt?.getTime() || 0));
    changed();
  }
  function watchChanges() {
    const boxes = [profileBox(state.profile), ...state.rBoxes.values()].filter(Boolean);
    const ids = new Set(areasForBoxes(boxes).map((a) => a.id));
    for (const [id, u] of changeUnsubs) {
      if (ids.has(id)) continue;
      u();
      changeUnsubs.delete(id);
      changesByArea.delete(id);
    }
    for (const id of ids) {
      if (changeUnsubs.has(id)) continue;
      changeUnsubs.set(
        id,
        onSnapshot(
          query(collection(db, 'areas', id, 'changes'), orderBy('detectedAt', 'desc'), limit(300)),
          (snap) => {
            changesByArea.set(id, snap.docs.map((d) => ({ id: d.id, ...d.data(), detectedAt: d.data().detectedAt?.toDate?.() || null })));
            mergeChanges();
          },
          fail,
        ),
      );
    }
    if (changeUnsubs.size !== changesByArea.size) mergeChanges();
  }

  // Restaurants: each shared area's list is split over a few "chunk" documents.
  const rUnsubs = new Map(); // areaId -> unsub
  const rByArea = new Map(); // areaId -> Map(chunkId -> list)
  function mergeRestaurants() {
    const m = new Map();
    for (const chunks of rByArea.values()) for (const list of chunks.values()) for (const r of list) m.set(r.id, r);
    state.restaurants = m;
    state.rLoaded = [...state.rAreas.keys()].every((id) => rByArea.has(id));
    changed();
  }
  function watchRestaurants() {
    const areas = areasForBoxes([...state.rBoxes.values()]);
    const ids = new Set(areas.map((a) => a.id));
    for (const [id, u] of rUnsubs) {
      if (ids.has(id)) continue;
      u();
      rUnsubs.delete(id);
      rByArea.delete(id);
      state.rAreas.delete(id);
    }
    for (const a of areas) {
      if (rUnsubs.has(a.id)) continue;
      state.rAreas.set(a.id, null);
      const u1 = onSnapshot(
        doc(db, 'rareas', a.id),
        (snap) => {
          state.rAreas.set(a.id, snap.exists() ? { id: a.id, ...snap.data(), updatedAt: snap.data().updatedAt?.toDate?.() || null } : null);
          changed();
        },
        fail,
      );
      const u2 = onSnapshot(
        collection(db, 'rareas', a.id, 'chunks'),
        (snap) => {
          rByArea.set(a.id, new Map(snap.docs.map((d) => [d.id, d.data().list || []])));
          mergeRestaurants();
        },
        fail,
      );
      rUnsubs.set(a.id, () => {
        u1();
        u2();
      });
    }
    mergeRestaurants();
  }
  const ready = () => {
    if (pending > 0 && --pending === 0) state.loading = false;
  };
  let scheduled = false;
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onChange(state);
    });
  };
  const fail = (e) => {
    console.error(e);
    state.error = e.message || String(e);
    changed();
  };

  function watchVenue(venueId) {
    if (venueUnsubs.has(venueId)) return;
    const since = Timestamp.fromMillis(Date.now() - 7 * 864e5);
    const u1 = onSnapshot(
      doc(db, 'venues', venueId),
      (snap) => {
        if (snap.exists()) state.venues.set(venueId, { id: venueId, ...snap.data() });
        else state.venues.delete(venueId);
        changed();
      },
      fail,
    );
    const u2 = onSnapshot(
      query(collection(db, 'venues', venueId, 'events'), where('start', '>=', since)),
      (snap) => {
        const m = new Map();
        for (const d of snap.docs) {
          const data = d.data();
          m.set(d.id, {
            ...data,
            id: d.id,
            venueId,
            key: `${venueId}__${d.id}`,
            start: data.start?.toDate(),
            end: data.end?.toDate() || null,
            firstSeenAt: data.firstSeenAt?.toDate?.() || null,
          });
        }
        state.events.set(venueId, m);
        changed();
      },
      fail,
    );
    venueUnsubs.set(venueId, () => {
      u1();
      u2();
    });
  }

  const unsubSubs = onSnapshot(
    collection(db, 'users', uid, 'subscriptions'),
    (snap) => {
      state.subscriptions = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      for (const id of state.subscriptions.keys()) watchVenue(id);
      for (const [id, unsub] of venueUnsubs) {
        if (!state.subscriptions.has(id)) {
          unsub();
          venueUnsubs.delete(id);
          state.venues.delete(id);
          state.events.delete(id);
        }
      }
      ready();
      changed();
    },
    fail,
  );

  const unsubProfile = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      state.profile = snap.exists() ? snap.data() : null;
      watchChanges();
      ready();
      changed();
    },
    fail,
  );

  const unsubReviews = onSnapshot(
    collection(db, 'users', uid, 'reviews'),
    (snap) => {
      state.reviews = new Map(snap.docs.map((d) => [d.id, d.data().state]));
      ready();
      changed();
    },
    fail,
  );

  const unsubRBoxes = onSnapshot(
    collection(db, 'users', uid, 'restaurantAreas'),
    (snap) => {
      state.rBoxes = new Map(
        snap.docs.filter((d) => MODE_IDS.includes(d.id)).map((d) => {
          const { s, w, n, e, pts } = d.data();
          return [d.id, storedBox(s, w, n, e, pts)];
        }).filter(([, b]) => b),
      );
      watchChanges();
      watchRestaurants();
      ready();
      changed();
    },
    fail,
  );

  const unsubRRatings = onSnapshot(
    collection(db, 'users', uid, 'restaurantRatings'),
    (snap) => {
      state.rRatings = new Map(snap.docs.map((d) => [d.id, d.data()]));
      ready();
      changed();
    },
    fail,
  );

  return {
    state,
    async addVenue(input, label = '') {
      const url = normalizeVenueUrl(input);
      if (!url) throw new Error("That doesn't look like a website address.");
      const id = await venueIdFor(url);
      if (state.subscriptions.has(id)) throw new Error('You already follow that page.');
      await setDoc(doc(db, 'users', uid, 'subscriptions', id), {
        url,
        label: label.trim().slice(0, 100),
        addedAt: serverTimestamp(),
        scanRequestedAt: serverTimestamp(),
      });
      return id;
    },
    async renameVenue(venueId, label) {
      await setDoc(doc(db, 'users', uid, 'subscriptions', venueId), { label: label.trim().slice(0, 100) }, { merge: true });
    },
    async rescanVenue(venueId) {
      await setDoc(doc(db, 'users', uid, 'subscriptions', venueId), { scanRequestedAt: serverTimestamp() }, { merge: true });
    },
    async removeVenue(venueId) {
      await deleteDoc(doc(db, 'users', uid, 'subscriptions', venueId));
    },
    async setReview(ev, reviewState) {
      const ref = doc(db, 'users', uid, 'reviews', ev.key);
      const current = state.reviews.get(ev.key);
      // Clicking the active state again clears it (back to "unreviewed").
      if (!reviewState || current === reviewState) {
        state.reviews.delete(ev.key);
        changed();
        await deleteDoc(ref);
        return;
      }
      state.reviews.set(ev.key, reviewState);
      changed();
      await setDoc(ref, { state: reviewState, venueId: ev.venueId, eventId: ev.id, updatedAt: serverTimestamp() });
    },
    async saveProfile({ homeLabel, box, suggestions }) {
      const data = { updatedAt: serverTimestamp() };
      if (homeLabel !== undefined) data.homeLabel = String(homeLabel).slice(0, 120);
      if (box !== undefined) {
        const b = normalizeBox(box);
        if (!b) throw new Error('That area is too small. Drag the corners out a bit.');
        Object.assign(data, { boxS: b.s, boxW: b.w, boxN: b.n, boxE: b.e, boxPts: b.pts ? flatPoints(b.pts) : deleteField() });
      }
      if (suggestions !== undefined) data.suggestions = !!suggestions;
      await setDoc(doc(db, 'users', uid), data, { merge: true });
    },
    /** Save the dine / takeout / delivery boxes ({mode: box}). */
    async saveRestaurantBoxes(boxes) {
      for (const [mode, box] of Object.entries(boxes)) {
        if (!MODE_IDS.includes(mode)) continue;
        const b = normalizeBox(box);
        if (!b) throw new Error(`The ${mode} area is too small. Drag its corners out a bit.`);
        const data = { s: b.s, w: b.w, n: b.n, e: b.e, updatedAt: serverTimestamp() };
        if (b.pts) data.pts = flatPoints(b.pts);
        await setDoc(doc(db, 'users', uid, 'restaurantAreas', mode), data);
      }
    },
    /** Toggle favorite / disliked for one way of eating at a restaurant. */
    async rateRestaurant(r, mode, rating) {
      if (!MODE_IDS.includes(mode) || (rating && !RATINGS.includes(rating))) return;
      const ref = doc(db, 'users', uid, 'restaurantRatings', r.id);
      const cur = { ...(state.rRatings.get(r.id) || {}) };
      delete cur.updatedAt;
      if (!rating || cur[mode] === rating) delete cur[mode];
      else cur[mode] = rating;
      const has = MODE_IDS.some((m) => cur[m]);
      if (has) state.rRatings.set(r.id, cur);
      else state.rRatings.delete(r.id);
      changed();
      if (!has) await deleteDoc(ref);
      else {
        const data = { name: String(r.name || '').slice(0, 120), updatedAt: serverTimestamp() };
        for (const m of MODE_IDS) if (cur[m]) data[m] = cur[m];
        await setDoc(ref, data);
      }
    },
    async clearHome() {
      await deleteDoc(doc(db, 'users', uid));
    },
    stop() {
      unsubProfile();
      unsubRBoxes();
      unsubRRatings();
      for (const u of changeUnsubs.values()) u();
      for (const u of rUnsubs.values()) u();
      unsubSubs();
      unsubReviews();
      for (const u of venueUnsubs.values()) u();
    },
  };
}
