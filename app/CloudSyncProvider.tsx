import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { Cloud, CloudOff, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { getDeviceId, initializeDatabase } from "@/lib/db";
import { getFirebaseConfig, getFirebaseServices, isFirebaseConfigured } from "@/lib/firebase";
import { FirestoreSyncEngine, type SyncEngineState } from "@/lib/sync/engine";

interface CloudSyncContextValue {
  configured: boolean;
  user: User | null;
  online: boolean;
  state: SyncEngineState;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  syncNow: () => Promise<void>;
}

const initialState: SyncEngineState = { status: "offline", pendingCount: 0 };
const CloudSyncContext = createContext<CloudSyncContextValue | null>(null);

export function useCloudSync() {
  const value = useContext(CloudSyncContext);
  if (!value) throw new Error("useCloudSync 必须在 CloudSyncProvider 内使用");
  return value;
}

export function CloudSyncProvider({ children }: { children: ReactNode }) {
  const configured = isFirebaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(configured);
  const [authError, setAuthError] = useState("");
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [state, setState] = useState<SyncEngineState>(initialState);
  const [engine, setEngine] = useState<FirestoreSyncEngine | null>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  useEffect(() => {
    if (!configured) return;
    const { auth, authReady } = getFirebaseServices();
    let active = true;
    authReady.then(() => getRedirectResult(auth)).catch((reason: unknown) => {
      if (active) setAuthError(readableAuthError(reason));
    });
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      setUser(nextUser); setAuthLoading(false);
    }, (reason) => { if (active) { setAuthError(readableAuthError(reason)); setAuthLoading(false); } });
    return () => { active = false; unsubscribe(); };
  }, [configured]);

  useEffect(() => {
    if (!configured || !user) { setEngine(null); return; }
    let active = true;
    let created: FirestoreSyncEngine | undefined;
    void initializeDatabase().then(async () => {
      if (!active) return;
      const { firestore } = getFirebaseServices();
      created = new FirestoreSyncEngine({
        firestore,
        uid: user.uid,
        deviceId: getDeviceId(),
        profile: { email: user.email, displayName: user.displayName, photoURL: user.photoURL },
        onState: (nextState) => { if (active) setState(nextState); },
      });
      setEngine(created);
      await created.start();
    }).catch((reason: unknown) => {
      if (active) setState({ status: navigator.onLine ? "error" : "offline", pendingCount: 0, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { active = false; created?.stop(); };
  }, [configured, user]);

  const login = useCallback(async () => {
    if (!configured) return;
    setAuthError("");
    const { auth, authReady } = getFirebaseServices();
    await authReady;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const authDomain = String(getFirebaseConfig().authDomain || "");
    const sameSiteRedirect = authDomain === window.location.hostname || window.location.hostname.endsWith(".firebaseapp.com") || window.location.hostname.endsWith(".web.app");
    try {
      if (mobile && sameSiteRedirect) await signInWithRedirect(auth, provider);
      else await signInWithPopup(auth, provider);
    } catch (reason) {
      const code = typeof reason === "object" && reason && "code" in reason ? String(reason.code) : "";
      if (mobile && code.includes("popup-blocked")) {
        await signInWithRedirect(auth, provider);
        return;
      }
      setAuthError(readableAuthError(reason));
      throw reason;
    }
  }, [configured]);

  const logout = useCallback(async () => {
    if (!configured) return;
    await signOut(getFirebaseServices().auth);
    setState(initialState);
  }, [configured]);

  const syncNow = useCallback(async () => {
    if (!engine) return;
    try { await engine.syncNow(); } catch { /* 状态由同步引擎统一呈现 */ }
  }, [engine]);

  const value = useMemo<CloudSyncContextValue>(() => ({ configured, user, online, state, login, logout, syncNow }), [configured, user, online, state, login, logout, syncNow]);

  if (configured && authLoading) return <div className="boot"><div className="brand-mark">青</div><h1>青蓝账本</h1><p>正在恢复登录状态…</p></div>;
  if (configured && !user) return <LoginScreen login={login} error={authError} online={online} />;
  return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
}

function LoginScreen({ login, error, online }: { login: () => Promise<void>; error: string; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { await login(); } catch { setBusy(false); } };
  return <main className="login-screen"><section className="login-card"><div className="login-brand"><div className="brand-mark">青</div><div><h1>青蓝账本</h1><p>同一账号，随时接着记</p></div></div><div className="login-visual"><Cloud /><span>本机 IndexedDB</span><i /><span>Firestore 云端</span></div><h2>登录你的个人账本</h2><p>登录后会先把旧账本安全迁移到云端，并在手机、电脑和平板之间实时增量同步。</p><button className="google-login" disabled={busy || !online} onClick={run}><LogIn />{busy ? "正在跳转…" : online ? "使用 Google 账号登录" : "离线，联网后可登录"}</button>{error && <p className="login-error">{error}</p>}<div className="login-security"><ShieldCheck /><span>每位用户的数据按 Firebase UID 隔离；本地缓存可继续离线记账。</span></div></section></main>;
}

function readableAuthError(reason: unknown) {
  const code = typeof reason === "object" && reason && "code" in reason ? String(reason.code) : "";
  if (code.includes("popup-closed")) return "登录窗口已关闭，请重试。";
  if (code.includes("unauthorized-domain")) return "当前域名尚未加入 Firebase 授权域名。";
  if (code.includes("network-request-failed")) return "网络连接失败，请检查网络后重试。";
  return reason instanceof Error ? reason.message : "Google 登录失败，请重试。";
}

export function SyncStatusGlyph({ compact = false }: { compact?: boolean }) {
  const { configured, online, state, syncNow } = useCloudSync();
  const status = !configured ? "disabled" : !online ? "offline" : state.status;
  const labels = {
    disabled: "云同步未配置",
    offline: `离线 · ${state.pendingCount} 项待同步`,
    syncing: "正在同步",
    success: state.pendingCount ? `${state.pendingCount} 项待同步` : "已同步",
    error: "同步失败",
  };
  return <button className={`sync-status ${status} ${compact ? "compact" : ""}`} onClick={() => void syncNow()} title={state.error || labels[status]}>
    {status === "offline" || status === "disabled" ? <CloudOff /> : <Cloud className={status === "syncing" ? "sync-spin" : ""} />}
    {!compact && <span>{labels[status]}</span>}{status === "syncing" && <RefreshCw className="sync-spin small" />}
  </button>;
}
