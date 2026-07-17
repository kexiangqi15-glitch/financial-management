import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { browserLocalPersistence, getAuth, setPersistence, type Auth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from "firebase/firestore";

declare global {
  interface Window {
    __QINGLAN_FIREBASE_CONFIG__?: FirebaseOptions | null;
  }
}

const environmentConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function getFirebaseConfig() {
  const runtime = typeof window !== "undefined" ? window.__QINGLAN_FIREBASE_CONFIG__ : undefined;
  return runtime?.apiKey ? runtime : environmentConfig;
}

export function isFirebaseConfigured() {
  const config = getFirebaseConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

let services: { app: FirebaseApp; auth: Auth; firestore: Firestore; authReady: Promise<void> } | null = null;

export function getFirebaseServices() {
  if (services) return services;
  if (!isFirebaseConfigured()) throw new Error("Firebase 尚未配置，请填写 VITE_FIREBASE_* 环境变量");
  const app = getApps().length ? getApp() : initializeApp(getFirebaseConfig());
  const auth = getAuth(app);
  const authReady = setPersistence(auth, browserLocalPersistence);
  const firestore = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  services = { app, auth, firestore, authReady };
  return services;
}
