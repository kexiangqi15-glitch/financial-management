import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cloud, CloudOff, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { getDeviceId, initializeDatabase } from "@/lib/db";
import {
  CloudSyncError,
  D1SyncEngine,
  type CloudProfile,
  type SyncEngineState,
} from "@/lib/sync/engine";

interface CloudSyncContextValue {
  configured: boolean;
  user: CloudProfile | null;
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
  const [configured, setConfigured] = useState(true);
  const [user, setUser] = useState<CloudProfile | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [state, setState] = useState<SyncEngineState>(initialState);
  const [engine, setEngine] = useState<D1SyncEngine | null>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let created: D1SyncEngine | undefined;
    void initializeDatabase().then(async () => {
      if (!active) return;
      created = new D1SyncEngine({
        deviceId: getDeviceId(),
        onState: (nextState) => { if (active) setState(nextState); },
        onProfile: (profile) => {
          if (!active) return;
          setUser(profile);
          setConfigured(true);
          setAuthRequired(false);
        },
      });
      setEngine(created);
      await created.start();
    }).catch((reason: unknown) => {
      if (!active) return;
      if (reason instanceof CloudSyncError && reason.status === 401) setAuthRequired(true);
      if (reason instanceof CloudSyncError && reason.status === 503) setConfigured(false);
      setState({
        status: navigator.onLine ? "error" : "offline",
        pendingCount: 0,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });
    return () => { active = false; created?.stop(); };
  }, []);

  const login = useCallback(async () => {
    window.location.assign("/signin-with-chatgpt?return_to=/");
  }, []);

  const logout = useCallback(async () => {
    window.location.assign("/signout-with-chatgpt?return_to=/");
  }, []);

  const syncNow = useCallback(async () => {
    if (!engine) return;
    try { await engine.syncNow(); } catch { /* 状态由同步引擎统一呈现 */ }
  }, [engine]);

  const value = useMemo<CloudSyncContextValue>(
    () => ({ configured, user, online, state, login, logout, syncNow }),
    [configured, user, online, state, login, logout, syncNow],
  );

  if (authRequired) return <LoginScreen login={login} online={online} error={state.error} />;
  return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
}

function LoginScreen({ login, error, online }: { login: () => Promise<void>; error?: string; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await login(); } finally { setBusy(false); }
  };
  return <main className="login-screen"><section className="login-card"><div className="login-brand"><div className="brand-mark">青</div><div><h1>青蓝账本</h1><p>同一账号，随时接着记</p></div></div><div className="login-visual"><Cloud /><span>本机 IndexedDB</span><i /><span>D1 云数据库</span></div><h2>登录你的统一账号</h2><p>登录后会把旧账本安全迁移到云端，并在手机、电脑和平板之间自动增量同步。</p><button className="google-login" disabled={busy || !online} onClick={run}><LogIn />{busy ? "正在跳转…" : online ? "使用统一账号登录" : "离线，联网后可登录"}</button>{error && <p className="login-error">{error}</p>}<div className="login-security"><ShieldCheck /><span>账号身份由站点平台校验；云端按账号隔离，本机仍可离线记账。</span></div></section></main>;
}

export function SyncStatusGlyph({ compact = false }: { compact?: boolean }) {
  const { configured, online, state, syncNow } = useCloudSync();
  const status = !configured ? "disabled" : !online ? "offline" : state.status;
  const labels = {
    disabled: "云数据库待启用",
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
