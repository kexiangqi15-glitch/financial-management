import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cloud, CloudOff, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { getDeviceId, initializeDatabase } from "@/lib/db";
import {
  CloudSyncError,
  D1SyncEngine,
  type CloudProfile,
  type SyncEngineState,
} from "@/lib/sync/engine";
import {
  clearExternalSyncCode,
  getExternalSyncCode,
  isExternalCloudClient,
  saveExternalSyncCode,
} from "@/lib/cloud-api";

interface CloudSyncContextValue {
  configured: boolean;
  user: CloudProfile | null;
  online: boolean;
  state: SyncEngineState;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  syncNow: () => Promise<void>;
  externalMode: boolean;
  createGitHubSyncCode: () => Promise<string>;
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
  const [externalCode, setExternalCode] = useState(() => getExternalSyncCode());

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [externalCode]);

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
    if (isExternalCloudClient) return;
    window.location.assign("/signin-with-chatgpt?return_to=/");
  }, []);

  const logout = useCallback(async () => {
    if (isExternalCloudClient) {
      clearExternalSyncCode();
      setExternalCode("");
      setUser(null);
      setAuthRequired(true);
      return;
    }
    window.location.assign("/signout-with-chatgpt?return_to=/");
  }, []);

  const createGitHubSyncCode = useCallback(async () => {
    if (isExternalCloudClient) throw new Error("请在原站点生成同步码");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch("/api/sync/external-link", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(value.error || "生成同步码失败");
    }
    saveExternalSyncCode(code);
    setExternalCode(code);
    return code;
  }, []);

  const syncNow = useCallback(async () => {
    if (!engine) return;
    try { await engine.syncNow(); } catch { /* 状态由同步引擎统一呈现 */ }
  }, [engine]);

  const value = useMemo<CloudSyncContextValue>(
    () => ({ configured, user, online, state, login, logout, syncNow, externalMode: isExternalCloudClient, createGitHubSyncCode }),
    [configured, user, online, state, login, logout, syncNow, createGitHubSyncCode],
  );

  if (authRequired) return <LoginScreen login={login} online={online} error={state.error} external={isExternalCloudClient} onExternalCode={(code) => { saveExternalSyncCode(code); setExternalCode(code); setAuthRequired(false); }} />;
  return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
}

function LoginScreen({ login, error, online, external, onExternalCode }: { login: () => Promise<void>; error?: string; online: boolean; external: boolean; onExternalCode: (code: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const run = async () => {
    setBusy(true);
    try { await login(); } finally { setBusy(false); }
  };
  if (external) return <main className="login-screen"><section className="login-card"><div className="login-brand"><div className="brand-mark">青</div><div><h1>青蓝账本</h1><p>GitHub Pages 安全同步</p></div></div><div className="login-visual"><Cloud /><span>本机 IndexedDB</span><i /><span>D1 云数据库</span></div><h2>输入你的同步码</h2><p>请先在原青蓝账本站点的“设置 → 账号与云同步”生成同步码。它相当于账本密码，请勿发给他人。</p><input className="sync-code-input" value={code} onChange={(event) => setCode(event.target.value.replace(/\s/g, ""))} placeholder="粘贴 48 位同步码" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><button className="google-login" disabled={!online || code.length < 32} onClick={() => onExternalCode(code)}><LogIn />{online ? "连接我的账本" : "离线，联网后可连接"}</button>{error && <p className="login-error">{error}</p>}<div className="login-security"><ShieldCheck /><span>同步码仅保存在本机浏览器；账目仍可在断网时继续记录。</span></div></section></main>;
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
