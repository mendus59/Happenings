// Firestore security rules tests. Run with:  npm run test:rules
// (starts the Firestore emulator via firebase-tools; needs Java)
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp, collection, getDocs } from 'firebase/firestore';

let env;
const VID = 'v_0123456789abcdef0123';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'happenings-rules-test',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'venues', VID), { name: 'Finnriver' });
    await setDoc(doc(db, 'venues', VID, 'events', 'e1'), { title: 'Jazz' });
    await setDoc(doc(db, 'users', 'alice', 'reviews', `${VID}__e1`), { state: 'favorite', venueId: VID, eventId: 'e1' });
  });
});
after(() => env?.cleanup());

const sub = () => ({ url: 'https://www.finnriver.com/farm-music-event-calendar', label: '', addedAt: serverTimestamp(), scanRequestedAt: serverTimestamp() });

test('signed-out users can read nothing', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'venues', VID)));
  await assertFails(getDocs(collection(db, 'venues', VID, 'events')));
});

test('signed-in users can read venues and events but never write them', async () => {
  const db = env.authenticatedContext('alice').firestore();
  await assertSucceeds(getDoc(doc(db, 'venues', VID)));
  await assertSucceeds(getDocs(collection(db, 'venues', VID, 'events')));
  await assertFails(setDoc(doc(db, 'venues', VID), { name: 'hacked' }));
  await assertFails(setDoc(doc(db, 'venues', VID, 'events', 'e2'), { title: 'spam' }));
});

test('users manage only their own subscriptions', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice', 'subscriptions', VID), sub()));
  await assertSucceeds(getDoc(doc(alice, 'users', 'alice', 'subscriptions', VID)));
  await assertFails(getDoc(doc(bob, 'users', 'alice', 'subscriptions', VID)));
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'subscriptions', VID), sub()));
  await assertFails(deleteDoc(doc(bob, 'users', 'alice', 'subscriptions', VID)));
  await assertSucceeds(deleteDoc(doc(alice, 'users', 'alice', 'subscriptions', VID)));
});

test('subscriptions are validated', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const ref = doc(alice, 'users', 'alice', 'subscriptions', VID);
  await assertFails(setDoc(ref, { ...sub(), url: 'javascript:alert(1)' }));
  await assertFails(setDoc(ref, { ...sub(), admin: true }));
  await assertFails(setDoc(doc(alice, 'users', 'alice', 'subscriptions', 'not-a-venue-id'), sub()));
  await assertFails(setDoc(ref, { ...sub(), label: 'x'.repeat(101) }));
});

test('reviews are private and only allow known states', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const ref = (db, uid) => doc(db, 'users', uid, 'reviews', `${VID}__e1`);
  await assertSucceeds(getDoc(ref(alice, 'alice')));
  await assertFails(getDoc(ref(bob, 'alice')));
  await assertFails(getDocs(collection(bob, 'users', 'alice', 'reviews')));
  await assertSucceeds(setDoc(ref(alice, 'alice'), { state: 'hidden', venueId: VID, eventId: 'e1', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(ref(alice, 'alice'), { state: 'owned', venueId: VID, eventId: 'e1' }));
  await assertFails(setDoc(ref(bob, 'alice'), { state: 'hidden', venueId: VID, eventId: 'e1' }));
});

test('profiles are private and validated', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const ok = { homeLabel: 'Port Orchard, WA', boxS: 47.4, boxW: -122.8, boxN: 47.8, boxE: -122.45, suggestions: true };
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), ok));
  await assertSucceeds(getDoc(doc(alice, 'users', 'alice')));
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), { suggestions: false }, { merge: true }));
  await assertFails(getDoc(doc(bob, 'users', 'alice')));
  await assertFails(setDoc(doc(bob, 'users', 'alice'), ok));
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxN: 50 })); // too tall
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxE: -123 })); // east of west edge
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxS: 'here' }));
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { homeLabel: 'x', boxS: 47.4 })); // partial box
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, homeLat: 47.5 })); // exact points not stored
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, admin: true }));
  const pts = [47.4, -122.8, 47.8, -122.8, 47.6, -122.45];
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxPts: pts }));
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxPts: pts.slice(0, 4) })); // fewer than 3 corners
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxPts: [...pts, 47.5] })); // odd length
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { ...ok, boxPts: new Array(34).fill(47.5) })); // too many corners
});

test('area changes are readable when signed in, never writable', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  await assertSucceeds(getDocs(collection(alice, 'areas', 'a_1', 'changes')));
  await assertFails(setDoc(doc(alice, 'areas', 'a_1', 'changes', 'x'), { name: 'fake' }));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'areas', 'a_1', 'changes')));
});

test('restaurant boxes and ratings are private and validated', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const box = { s: 47.5, w: -122.7, n: 47.58, e: -122.58, updatedAt: serverTimestamp() };
  const area = (db, mode) => doc(db, 'users', 'alice', 'restaurantAreas', mode);
  await assertSucceeds(setDoc(area(alice, 'takeout'), box));
  await assertSucceeds(getDoc(area(alice, 'takeout')));
  await assertFails(getDoc(area(bob, 'takeout')));
  await assertFails(setDoc(area(alice, 'picnic'), box));
  await assertFails(setDoc(area(alice, 'dine'), { ...box, n: 49.5 }));
  await assertFails(setDoc(area(alice, 'dine'), { s: 47.5, w: -122.7 }));
  await assertFails(setDoc(area(alice, 'dine'), { ...box, extra: 1 }));
  await assertSucceeds(setDoc(area(alice, 'dine'), { ...box, pts: [47.5, -122.7, 47.58, -122.7, 47.55, -122.58] }));
  await assertFails(setDoc(area(alice, 'dine'), { ...box, pts: 'square' }));
  const rating = (db) => doc(db, 'users', 'alice', 'restaurantRatings', 'r_node_42');
  await assertSucceeds(setDoc(rating(alice), { dine: 'fav', delivery: 'dislike', name: 'Thai Place', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDocs(collection(alice, 'users', 'alice', 'restaurantRatings')));
  await assertFails(getDoc(rating(bob)));
  await assertFails(setDoc(rating(bob), { dine: 'fav' }));
  await assertFails(setDoc(rating(alice), { dine: 'love' }));
  await assertFails(setDoc(doc(alice, 'users', 'alice', 'restaurantRatings', 'not-an-id'), { dine: 'fav' }));
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice', 'restaurantRatings', 'r_lcb_428751'), { takeout: 'fav', name: 'Brand New Bistro' }));
});

test('shared restaurant lists are readable when signed in, never writable', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  await assertSucceeds(getDocs(collection(alice, 'rareas', 'a_1', 'chunks')));
  await assertSucceeds(getDoc(doc(alice, 'rareas', 'a_1')));
  await assertFails(setDoc(doc(alice, 'rareas', 'a_1', 'chunks', '0'), { list: [] }));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'rareas', 'a_1', 'chunks')));
});

test('unknown collections are closed', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { x: 1 }));
  await assertFails(setDoc(doc(alice, 'users', 'alice', 'secrets', 'a'), { x: 1 }));
  await assertFails(setDoc(doc(alice, 'other', 'x'), { x: 1 }));
});
