import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, EMAIL_LINK_REDIRECT_URL } from "../lib/firebase";
import { api, type LicenseInfo } from "../lib/api";

/** Shape of the per-user Firestore doc at users/{uid}. The license key lives
 *  here so signing in on another device (especially iOS, where there's no
 *  in-app purchase) unlocks the app from the account alone. */
interface UserDoc {
  email?: string;
  licenseKey?: string;
  licenseStatus?: string;
  licenseProductName?: string | null;
  licenseUpdatedAt?: string;
}

export type SignInPhase = "idle" | "sending" | "waitingForLink";

/**
 * Owns the account (Firebase auth) and licensing (Lemon Squeezy) state for
 * the whole app, including the two-way sync between the locally activated
 * license (OS keychain, via Rust) and the signed-in user's Firestore doc:
 *
 * - local license, no key in account  -> push the key up to Firestore
 * - key in account, no local license  -> activate it here automatically
 */
export function useAccount() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [signInPhase, setSignInPhase] = useState<SignInPhase>("idle");
  const [signInError, setSignInError] = useState<string | null>(null);

  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [licenseLoaded, setLicenseLoaded] = useState(false);
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  const licenseRef = useRef(license);
  licenseRef.current = license;

  // Track auth state (persisted by the Firebase SDK across app restarts).
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoaded(true);
    });
    return unsubscribe;
  }, []);

  // Load the locally stored license once on mount — offline-first, so the
  // app unlocks without any network round-trip.
  useEffect(() => {
    let cancelled = false;
    api
      .licenseGet()
      .then((info) => {
        if (!cancelled) setLicense(info);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLicenseLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const writeLicenseToAccount = useCallback(async (u: User, info: LicenseInfo) => {
    const payload: UserDoc = {
      email: u.email ?? undefined,
      licenseKey: info.key,
      licenseStatus: info.status,
      licenseProductName: info.productName ?? null,
      licenseUpdatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, "users", u.uid), payload, { merge: true });
  }, []);

  // Two-way license sync whenever both auth and the local license state are
  // known. Runs once per sign-in (guarded by syncedForUid).
  const syncedForUid = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !licenseLoaded) return;
    if (syncedForUid.current === user.uid) return;
    syncedForUid.current = user.uid;

    (async () => {
      try {
        const snapshot = await getDoc(doc(db, "users", user.uid));
        const remote = (snapshot.data() ?? {}) as UserDoc;
        const local = licenseRef.current;

        if (local && !remote.licenseKey) {
          // This device has a license the account doesn't know about yet.
          await writeLicenseToAccount(user, local);
        } else if (!local && remote.licenseKey) {
          // The account carries a license (activated on another device) —
          // activate a new instance for this device automatically.
          const info = await api.licenseActivate(remote.licenseKey);
          setLicense(info);
          await writeLicenseToAccount(user, info);
        }
      } catch {
        // Sync is best-effort — a failure here must never block the app.
        // The user can still activate manually from Settings.
        syncedForUid.current = null;
      }
    })();
  }, [user, licenseLoaded, writeLicenseToAccount]);

  const signIn = useCallback(async (email: string) => {
    const trimmed = email.trim();
    if (!trimmed) {
      setSignInError("please enter your email address");
      return;
    }
    setSignInError(null);
    setSignInPhase("sending");
    try {
      await sendSignInLinkToEmail(auth, trimmed, {
        url: EMAIL_LINK_REDIRECT_URL,
        handleCodeInApp: true,
      });
      setSignInPhase("waitingForLink");
      const link = await api.authWaitForEmailLinkCallback();
      if (!isSignInWithEmailLink(auth, link)) {
        throw new Error("the sign-in link was invalid — please try again");
      }
      await signInWithEmailLink(auth, trimmed, link);
      // onAuthStateChanged updates `user`; the sync effect handles the rest.
    } catch (err) {
      setSignInError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "sign-in failed — please try again",
      );
    } finally {
      setSignInPhase("idle");
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
    syncedForUid.current = null;
    // The local license stays — signing out doesn't revoke this device.
  }, []);

  const activateLicense = useCallback(
    async (key: string) => {
      setLicenseBusy(true);
      setLicenseError(null);
      try {
        const info = await api.licenseActivate(key);
        setLicense(info);
        if (user) {
          await writeLicenseToAccount(user, info).catch(() => {});
        }
      } catch (err) {
        setLicenseError(
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : "activation failed — please try again",
        );
      } finally {
        setLicenseBusy(false);
      }
    },
    [user, writeLicenseToAccount],
  );

  const deactivateLicense = useCallback(async () => {
    setLicenseBusy(true);
    setLicenseError(null);
    try {
      await api.licenseDeactivate();
      setLicense(null);
    } catch (err) {
      setLicenseError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "deactivation failed — please try again",
      );
    } finally {
      setLicenseBusy(false);
    }
  }, []);

  return {
    user,
    authLoaded,
    signInPhase,
    signInError,
    signIn,
    signOutUser,
    license,
    licenseLoaded,
    licenseBusy,
    licenseError,
    activateLicense,
    deactivateLicense,
  };
}

export type AccountApi = ReturnType<typeof useAccount>;
