import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type UserCredential,
} from 'firebase/auth';
import type { SSOPublicConfigOut } from '../types/api';

function buildFirebaseConfigKey(cfg: SSOPublicConfigOut): string {
  return [
    cfg.firebase_project_id,
    cfg.firebase_auth_domain,
    cfg.firebase_api_key,
    cfg.firebase_app_id,
    cfg.firebase_tenant_id,
  ].join('|');
}

let cachedConfigKey = '';
let cachedAuth: Auth | null = null;

export function getFirebaseAuthInstance(cfg: SSOPublicConfigOut): Auth {
  const key = buildFirebaseConfigKey(cfg);
  if (cachedAuth && cachedConfigKey === key) {
    return cachedAuth;
  }

  const appName = `bca-${cfg.firebase_project_id || 'default'}`;
  const existing = getApps().find((a) => a.name === appName);
  const app: FirebaseApp = existing
    ? getApp(appName)
    : initializeApp(
        {
          apiKey: cfg.firebase_api_key,
          authDomain: cfg.firebase_auth_domain,
          projectId: cfg.firebase_project_id,
          ...(cfg.firebase_app_id ? { appId: cfg.firebase_app_id } : {}),
        },
        appName
      );

  const auth = getAuth(app);
  auth.tenantId = cfg.firebase_tenant_id.trim() || null;
  cachedConfigKey = key;
  cachedAuth = auth;
  return auth;
}

export async function consumeFirebaseRedirect(auth: Auth): Promise<UserCredential | null> {
  return getRedirectResult(auth);
}

export async function signInWithGoogle(auth: Auth): Promise<UserCredential | null> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/popup-blocked') {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

export async function signInWithMicrosoft(auth: Auth): Promise<UserCredential | null> {
  const provider = new OAuthProvider('microsoft.com');
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/popup-blocked') {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

export async function signInWithEmail(
  auth: Auth,
  email: string,
  password: string
): Promise<UserCredential> {
  return signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function requestPasswordReset(auth: Auth, email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOutFirebase(auth: Auth): Promise<void> {
  await signOut(auth);
}

export function formatFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'this domain';

  switch (code) {
    case 'auth/unauthorized-domain':
      return `Domain "${hostname}" is not in Firebase Authorized Domains. Add it in Firebase Console → Authentication → Settings → Authorized domains.`;
    case 'auth/popup-closed-by-user':
      return 'Sign-in window was closed before completing.';
    case 'auth/cancelled-popup-request':
      return 'Another sign-in prompt was already open.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email address or password.';
    case 'auth/user-disabled':
      return 'This account has been disabled in Firebase Authentication.';
    case 'auth/too-many-requests':
      return 'Too many sign-in attempts. Please wait a moment and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in provider is not enabled in Firebase Authentication.';
    default:
      if (err instanceof Error && err.message) {
        return err.message;
      }
      return 'Sign-in failed. Please try again.';
  }
}
