import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

// Public web config — safe to embed client-side (Firebase's client config is
// not a secret; access is controlled by Firestore/Auth security rules, not
// by keeping this config private).
const firebaseConfig = {
  apiKey: "AIzaSyB7p41p0mFf4VMj6IAx2TFz4usgsgmtxUw",
  authDomain: "session-9d77a.firebaseapp.com",
  projectId: "session-9d77a",
  storageBucket: "session-9d77a.firebasestorage.app",
  messagingSenderId: "124913218138",
  appId: "1:124913218138:web:c3382806b6eadc9a981e63",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
// Region must match the `region` option on every onCall Cloud Function.
export const functions = getFunctions(firebaseApp, "europe-west3");

/** Where the guest share SPA is hosted (Firebase Hosting). */
export const SHARE_BASE_URL = "https://session-9d77a.web.app";

/**
 * Loopback URL Firebase embeds in the magic-link email. Port 5174 — distinct
 * from Dropbox's 5173 loopback listener (see dropbox.rs) and from Vite's dev
 * server on 1420. A Rust command (`auth_wait_for_email_link_callback`) binds
 * this port temporarily while we wait for the user to click the email link,
 * which opens in the system browser and hits this loopback address.
 */
export const EMAIL_LINK_REDIRECT_URL = "http://localhost:5174/auth/callback";
