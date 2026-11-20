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
  Timestamp,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { normalizeVenueUrl, venueIdFor } from '../../shared/url.js';
import { areaFor, normalizeBox, profileBox } from '../../shared/geo.js';

export const REVIEW_STATES = ['interested', 'favorite', 'hidden'];

export function createStore(uid, onChange) {
  const state = {
    loading: true,
    subscriptions: new Map(), // venueId -> {url, label, addedAt, scanRequestedAt}
    venues: new Map(), // venueId -> venue doc
    events: new Map(), // venueId -> Map(eventId -> event)
    reviews: new Map(), // `${venueId}__${eventId}` -> state
    profile: null, // { homeLabel, boxS, boxW, boxN, boxE, suggestions }
    area: null,
    areaChanges: [],
    error: null,
  };
  const venueUnsubs = new Map();
  let pending = 3;
  let areaUnsub = null;
  let areaId = null;
  function watchArea() {
    const p = state.profile;
    const next = areaFor(profileBox(p));
    if ((next?.id || null) === areaId) return;
    areaUnsub?.();
    areaUnsub = null;
    areaId = next?.id || null;
    state.area = next;
    state.areaChanges = [];
    if (!next) return;
    areaUnsub = onSnapshot(
      query(collection(db, 'areas', next.id, 'changes'), orderBy('detectedAt', 'desc'), limit(300)),
      (snap) => {
        state.areaChanges = snap.docs.map((d) => ({ id: d.id, ...d.data(), detectedAt: d.data().detectedAt?.toDate?.() || null }));
        changed();
      },
      fail,
    );
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
      watchArea();
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
        Object.assign(data, { boxS: b.s, boxW: b.w, boxN: b.n, boxE: b.e });
      }
      if (suggestions !== undefined) data.suggestions = !!suggestions;
      await setDoc(doc(db, 'users', uid), data, { merge: true });
    },
    async clearHome() {
      await deleteDoc(doc(db, 'users', uid));
    },
    stop() {
      unsubProfile();
      areaUnsub?.();
      unsubSubs();
      unsubReviews();
      for (const u of venueUnsubs.values()) u();
    },
  };
}
