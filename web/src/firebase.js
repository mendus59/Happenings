import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

// The web config is public by design; access is controlled by Firestore security rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyAxkOWWp-vKtec-HVNrYbvex94TjMRq48c',
  authDomain: 'happenings-79a0e.firebaseapp.com',
  projectId: 'happenings-79a0e',
  storageBucket: 'happenings-79a0e.firebasestorage.app',
  messagingSenderId: '403257386952',
  appId: '1:403257386952:web:f14bb4168fb5cbec92c2fd',
  measurementId: 'G-B1845776LR',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Local development against the Firebase emulators: open http://localhost:5173/?emulator
export const usingEmulator = new URLSearchParams(location.search).has('emulator');
if (usingEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// Analytics is optional and loaded lazily so it never blocks the app.
if (!usingEmulator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  import('firebase/analytics')
    .then(async ({ getAnalytics, isSupported }) => {
      if (await isSupported()) getAnalytics(app);
    })
    .catch(() => {});
}
