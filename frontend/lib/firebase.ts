import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getApp(): FirebaseApp {
  return getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
}

// Lazy singletons — only initialized on first access (avoids SSR/build crashes when env vars are missing)
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

export function getStorageInstance(): FirebaseStorage {
  if (!_storage) _storage = getStorage(getApp());
  return _storage;
}

export const auth: Auth = new Proxy({} as Auth, {
  get(_, prop) {
    if (!_auth) _auth = getAuth(getApp());
    return (_auth as unknown as Record<string, unknown>)[prop as string];
  },
});

/** Get the Firestore instance (lazy-initialized). Use this instead of `db` for doc()/collection() calls. */
export function getDbInstance(): Firestore {
  if (!_db) _db = getFirestore(getApp());
  return _db;
}

// Proxy kept for backward compat but prefer getDbInstance() for doc()/collection() calls
export const db: Firestore = new Proxy({} as Firestore, {
  get(_, prop) {
    if (!_db) _db = getFirestore(getApp());
    return (_db as unknown as Record<string, unknown>)[prop as string];
  },
});

// storage proxy kept for backward compat but prefer getStorageInstance() for ref() calls
export const storage: FirebaseStorage = new Proxy({} as FirebaseStorage, {
  get(_, prop) {
    if (!_storage) _storage = getStorage(getApp());
    return (_storage as unknown as Record<string, unknown>)[prop as string];
  },
});
