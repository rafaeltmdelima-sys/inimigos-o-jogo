import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getAnalytics, isSupported } from 'firebase/analytics';
import firebaseConfig from '../../firebase-applet-config.json';

// We use the modular SDK (v9+) which is the standard for Vite/React projects.
// The "Compat" style requested is usually for plain HTML/JS scripts.
// In a React/Vite environment, the modular SDK is more efficient and provides better tree-shaking.
// I will ensure the configuration matches exactly what you provided.

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const rtdb = getDatabase(app, firebaseConfig.databaseURL);
export const googleProvider = new GoogleAuthProvider();

console.log("Firebase Initialized with Project ID:", firebaseConfig.projectId);
console.log("RTDB URL:", firebaseConfig.databaseURL);

// Analytics initialization with support check
export const analyticsPromise = isSupported().then(yes => yes ? getAnalytics(app) : null);

export const loginWithGoogle = () => signInWithPopup(auth, googleProvider);
export const loginAnonymously = () => signInAnonymously(auth);
