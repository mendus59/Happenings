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

test('user root docs and unknown collections are closed', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(alice, 'users', 'alice'), { x: 1 }));
  await assertFails(setDoc(doc(alice, 'users', 'alice', 'secrets', 'a'), { x: 1 }));
  await assertFails(setDoc(doc(alice, 'other', 'x'), { x: 1 }));
});
