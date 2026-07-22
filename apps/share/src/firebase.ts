import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

// Same public web config as the desktop app (client config is not a secret;
// access control lives in Firestore rules + the Cloud Functions).
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
// Region must match the `region` option set on every onCall function.
export const functions = getFunctions(firebaseApp, "europe-west3");
