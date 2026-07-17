"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ArrowDownLeft, ArrowRightLeft, ArrowUpRight, BarChart3, Bell, BriefcaseBusiness, CalendarDays, Check,
  ChevronRight, CircleDollarSign, Download, FileUp, Home, Landmark, Menu, Moon, MoreHorizontal, Plus,
  ReceiptText, RotateCcw, Search, Settings, ShieldCheck, Sun, Trash2, WalletCards, X, Zap, LogOut, RefreshCw,
} from "lucide-react";
import { db, exportBackup, exportTransactionsCsv, importBackup, initializeDatabase, loadSnapshot, queueLocalChange, resetDatabase } from "@/lib/db";
import {
  calculateAccountBalances, calculateSafetyLine, calculateSalarySnapshot, calculateWeeklyBudget, currentAvailable,
  forecastCashflow, salaryExpectedPayments, simulatePurchase, summarizeInstallments, toLocalDate, weeklySpent,
} from "@/lib/calculations";
import type { Cents, LedgerSnapshot, LedgerTransaction, LocalDate, TransactionType } from "@/lib/types";
import { asCents, formatMoney, uid } from "@/lib/types";
import { SyncStatusGlyph, useCloudSync } from "./CloudSyncProvider";

type View = "home" | "transactions" | "add" | "budget" | "salary" | "installments" | "calendar" | "analytics" | "accounts" | "settings";
const TODAY = toLocalDate(new Date());
const typeLabels: Record<TransactionType, string> = {
  expense: "支出", income: "收入", transfer: "转账", refund: "退款", loan_out: "借出", loan_repayment: "收回",
  salary_payment: "工资到账", installment_payment: "分期付款", adjustment: "余额调整",
};
const palette = ["#22a6b3", "#3b82f6", "#6d8dff", "#63c5a6", "#f2a65a", "#9c86d7"];

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

export function LedgerApp() {
  const cloud = useCloudSync();
  const [data, setData] = useState<LedgerSnapshot | null>(null);
  const [view, setView] = useState<View>("home");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState<LedgerTransaction | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await loadSnapshot());
      const syncedTheme = await db.settings.get("theme");
      if (syncedTheme?.value === "light" || syncedTheme?.value === "dark") setTheme(syncedTheme.value);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取本地数据失败"); }
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem("qinglan-theme") as "light" | "dark" | null;
    if (saved) setTheme(saved);
    initializeDatabase().then(refresh).finally(() => setLoading(false));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, [refresh]);
  useEffect(() => { window.addEventListener("qinglan:data-changed", refresh); return () => window.removeEventListener("qinglan:data-changed", refresh); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("qinglan-theme", theme); }, [theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2600); return () => clearTimeout(timer); }, [toast]);

  const metrics = useMemo(() => data ? deriveMetrics(data) : null, [data]);
  const changeTheme = useCallback(async (next: "light" | "dark") => {
    setTheme(next); await db.settings.put({ key: "theme", value: next }); await queueLocalChange("settings", "theme");
  }, []);
  const navigate = (next: View) => { setView(next); if (next !== "add") setEditing(null); window.scrollTo({ top: 0, behavior: "smooth" }); };

  if (loading) return <div className="boot"><div className="brand-mark">青</div><h1>青蓝账本</h1><p>正在打开你的本地账本…</p></div>;
  if (error || !data || !metrics) return <div className="boot error"><h1>账本暂时无法打开</h1><p>{error}</p><button onClick={() => refresh()}>重新加载</button></div>;

  const title: Record<View, string> = { home: "现金流总览", transactions: "交易流水", add: editing ? "编辑记录" : "记一笔", budget: "每周预算", salary: "工资与应收", installments: "分期管理", calendar: "现金流日历", analytics: "统计分析", accounts: "账户管理", settings: "设置与备份" };

  return <div className="app-shell">
    <Sidebar view={view} navigate={navigate} />
    <main className="main">
      <header className="topbar">
        <div><p className="eyebrow">2026 学生现金流计划</p><h1>{title[view]}</h1></div>
        <div className="top-actions"><SyncStatusGlyph /><button className="icon-btn" aria-label="切换主题" onClick={() => void changeTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? <Moon /> : <Sun />}</button><button className="avatar account-avatar" onClick={() => navigate("settings")}>{cloud.user?.photoURL ? <img src={cloud.user.photoURL} alt={cloud.user.displayName || "Google 头像"} /> : "青"}</button></div>
      </header>
      {view === "home" && <Dashboard data={data} metrics={metrics} navigate={navigate} />}
      {view === "transactions" && <Transactions data={data} onRefresh={refresh} onEdit={(tx) => { setEditing(tx); setView("add"); }} setToast={setToast} />}
      {view === "add" && <QuickEntry data={data} editing={editing} onDone={async () => { await refresh(); setEditing(null); setToast(editing ? "记录已更新" : "已记入账本"); navigate("transactions"); }} onCancel={() => navigate("transactions")} />}
      {view === "budget" && <BudgetView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "salary" && <SalaryView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "installments" && <InstallmentsView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "calendar" && <CalendarView data={data} metrics={metrics} />}
      {view === "analytics" && <AnalyticsView data={data} />}
      {view === "accounts" && <AccountsView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "settings" && <SettingsView data={data} theme={theme} setTheme={(next) => void changeTheme(next)} onRefresh={refresh} setToast={setToast} />}
    </main>
    <MobileNav view={view} navigate={navigate} />
    {toast && <div className="toast"><Check size={18} />{toast}</div>}
  </div>;
}

function deriveMetrics(data: LedgerSnapshot) {
  const balance = currentAvailable(data.accounts, data.transactions);
  const balances = calculateAccountBalances(data.accounts, data.transactions);
  const salary = calculateSalarySnapshot(data.salaryPlans, data.attendance, data.transactions, TODAY);
  const safety = calculateSafetyLine(data.reserves, data.installmentItems, data.budget, TODAY);
  const expectedIncome = data.salaryPlans.flatMap((p) => salaryExpectedPayments(p, data.attendance));
  const nextIncome = expectedIncome.find((x) => x.date >= TODAY);
  const spent = weeklySpent(data.transactions, TODAY, data.budget.weekStartsOn);
  const weekly = calculateWeeklyBudget({ availableCents: balance, safetyCents: safety.totalCents, nextIncomeDate: nextIncome?.date, asOf: TODAY, settings: data.budget, spentCents: spent });
  const installments = summarizeInstallments(data.installmentItems, TODAY);
  return { balance, balances, salary, safety, expectedIncome, nextIncome, weekly, installments, free: Math.max(0, balance - safety.totalCents), gap: Math.max(0, safety.totalCents - balance) };
}

const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home }, { id: "transactions", label: "账单", icon: ReceiptText }, { id: "budget", label: "预算", icon: ShieldCheck },
  { id: "salary", label: "工资", icon: BriefcaseBusiness }, { id: "installments", label: "分期", icon: CalendarDays }, { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "analytics", label: "统计", icon: BarChart3 }, { id: "accounts", label: "账户", icon: Landmark }, { id: "settings", label: "设置", icon: Settings },
];
function Sidebar({ view, navigate }: { view: View; navigate: (view: View) => void }) {
  const { configured } = useCloudSync();
  return <aside className="sidebar"><div className="brand"><div className="brand-mark">青</div><div><strong>青蓝账本</strong><small>放心花每一笔钱</small></div></div><nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => navigate(id)}><Icon />{label}</button>)}</nav><div className="privacy"><ShieldCheck /><div><strong>{configured ? "本地优先云同步" : "本地安全模式"}</strong><span>{configured ? "IndexedDB · Firestore · 可离线" : "配置 Firebase 后跨设备同步"}</span></div></div></aside>;
}
function MobileNav({ view, navigate }: { view: View; navigate: (view: View) => void }) {
  const items: { id: View; label: string; icon: typeof Home }[] = [{ id: "home", label: "首页", icon: Home }, { id: "transactions", label: "账单", icon: ReceiptText }, { id: "add", label: "记一笔", icon: Plus }, { id: "budget", label: "预算", icon: ShieldCheck }, { id: "settings", label: "我的", icon: MoreHorizontal }];
  return <nav className="mobile-nav">{items.map(({ id, label, icon: Icon }) => <button key={id} className={`${view === id ? "active" : ""} ${id === "add" ? "add" : ""}`} onClick={() => navigate(id)}><Icon /><span>{label}</span></button>)}</nav>;
}

function Dashboard({ data, metrics: m, navigate }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; navigate: (v: View) => void }) {
  const forecastDates = ["2026-08-15", "2026-08-19", "2026-09-01", "2026-09-15", data.budget.customForecastDate].filter((v, i, a) => a.indexOf(v) === i) as LocalDate[];
  const safetyState = m.gap > 0 ? "已低于安全线" : m.free < 35000 ? "接近警戒线" : m.free < 70000 ? "需要控制" : "安全";
  return <div className="page-stack">
    <section className="hero-card">
      <div className="hero-copy"><div className="status-pill warning"><span />{safetyState}</div><p>当前真正可自由支配</p><h2>{formatMoney(m.free)}</h2><p className="muted">已到账 {formatMoney(m.balance)} · 锁定 {formatMoney(m.safety.totalCents)}</p><div className="hero-actions"><button className="primary" onClick={() => navigate("add")}><Plus />记一笔</button><button className="secondary" onClick={() => navigate("budget")}><Zap />消费模拟</button></div></div>
      <div className="safety-ring" style={{ "--progress": `${Math.min(100, Math.round(m.balance / Math.max(1, m.safety.totalCents) * 100))}%` } as React.CSSProperties}><div><strong>{Math.min(100, Math.round(m.balance / Math.max(1, m.safety.totalCents) * 100))}%</strong><span>安全线覆盖</span></div></div>
    </section>
    <section className="metric-grid">
      <MetricCard icon={<WalletCards />} label="已到账余额" value={formatMoney(m.balance)} sub="不含尚未到账工资" tone="blue" />
      <MetricCard icon={<BriefcaseBusiness />} label="已赚未到账" value={formatMoney(m.salary.receivableCents)} sub={`未来预计 ${formatMoney(m.salary.futureCents)}`} tone="cyan" />
      <MetricCard icon={<ShieldCheck />} label="当前锁定资金" value={formatMoney(m.safety.totalCents)} sub={`仍有缺口 ${formatMoney(m.gap)}`} tone="violet" />
      <MetricCard icon={<Zap />} label="本周剩余预算" value={formatMoney(m.weekly.remainingCents)} sub={`本周已花 ${formatMoney(m.weekly.spentCents)}`} tone="green" />
    </section>
    <section className="content-grid">
      <Card title="本周预算" action="查看预算" onAction={() => navigate("budget")}><BudgetMini weekly={m.weekly} /></Card>
      <Card title="工资进度" action="工资明细" onAction={() => navigate("salary")}><div className="salary-summary"><div><span>累计已赚</span><strong>{formatMoney(m.salary.earnedCents)}</strong></div><div><span>下次预计到账</span><strong>{m.nextIncome ? formatMoney(m.nextIncome.amountCents) : "—"}</strong><small>{m.nextIncome?.date ?? "等待设置"}</small></div></div><Insight icon={<BriefcaseBusiness />} text={`你已赚取 ${formatMoney(m.salary.earnedCents)}，其中 ${formatMoney(m.salary.receivableCents)} 尚未到账，不计入当前可消费余额。`} /></Card>
      <Card title="安全资金构成" action="管理设置" onAction={() => navigate("settings")}><div className="reserve-list">{data.reserves.map((r) => <div key={r.id}><span><i className={`dot ${r.kind}`} />{r.name}</span><strong>{formatMoney(r.amountCents)}</strong></div>)}<div><span><i className="dot installment" />近期分期</span><strong>{formatMoney(m.safety.installmentCents)}</strong></div></div></Card>
      <Card title="最近现金流" action="全部流水" onAction={() => navigate("transactions")}><TransactionList items={data.transactions.slice(0, 4)} data={data} compact /></Card>
    </section>
    <Card title="未来资金预测" action="现金流日历" onAction={() => navigate("calendar")}><div className="forecast-table"><div className="forecast-head"><span>日期</span><span>保守余额</span><span>工资按期到账</span><span>自由资金</span></div>{forecastDates.map((date) => { const conservative = forecastCashflow({ targetDate: date, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, includeExpectedIncome: false }); const expected = forecastCashflow({ targetDate: date, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, includeExpectedIncome: true }); return <div className="forecast-row" key={date}><span>{date.slice(5).replace("-", "月")}日</span><strong>{formatMoney(conservative.balanceCents)}</strong><strong>{formatMoney(expected.balanceCents)}</strong><span className={expected.balanceCents - m.safety.totalCents < 0 ? "negative" : "positive"}>{formatMoney(Math.max(0, expected.balanceCents - m.safety.totalCents))}</span></div>; })}</div></Card>
  </div>;
}
function MetricCard({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub: string; tone: string }) { return <article className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div></article>; }
function Card({ title, action, onAction, children }: { title: string; action?: string; onAction?: () => void; children: React.ReactNode }) { return <section className="card"><div className="card-head"><h2>{title}</h2>{action && <button onClick={onAction}>{action}<ChevronRight /></button>}</div>{children}</section>; }
function Insight({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="insight">{icon}<p>{text}</p></div>; }
function BudgetMini({ weekly }: { weekly: ReturnType<typeof calculateWeeklyBudget> }) { const percent = weekly.budgetCents ? Math.min(100, Math.round(weekly.spentCents / weekly.budgetCents * 100)) : 100; return <div><div className="budget-main"><div><span>建议预算</span><strong>{formatMoney(weekly.budgetCents)}</strong></div><div><span>日均可用</span><strong>{formatMoney(Math.max(0, Math.floor(weekly.remainingCents / 4)))}</strong></div></div><div className="progress"><i style={{ width: `${percent}%` }} /></div><div className="budget-labels"><span>已使用 {percent}%</span><span>剩余 {formatMoney(weekly.remainingCents)}</span></div>{weekly.gapCents > 0 && <Insight icon={<Bell />} text={`现金流缺口 ${formatMoney(weekly.gapCents)}，本周自由预算已自动降为 0。`} />}</div>; }

function Transactions({ data, onRefresh, onEdit, setToast }: { data: LedgerSnapshot; onRefresh: () => Promise<void>; onEdit: (tx: LedgerTransaction) => void; setToast: (s: string) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState("all"); const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const items = data.transactions.filter((t) => (type === "all" || t.type === type) && `${t.note} ${t.merchant}`.toLowerCase().includes(query.toLowerCase()));
  const remove = async (id: string) => { if (pendingDelete !== id) { setPendingDelete(id); setToast("再次点击删除以确认"); return; } await db.transactions.delete(id); await queueLocalChange("transactions", id, "delete"); setPendingDelete(null); await onRefresh(); setToast("记录已删除"); };
  return <div className="page-stack"><div className="toolbar"><label className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商家、备注或标签" /></label><select value={type} onChange={(e) => setType(e.target.value)}><option value="all">全部类型</option><option value="expense">支出</option><option value="income">收入</option><option value="refund">退款</option><option value="transfer">转账</option></select><button className="primary" onClick={() => onEdit(null as unknown as LedgerTransaction)}><Plus />记一笔</button></div><Card title={`全部流水 · ${items.length} 笔`}><TransactionList items={items} data={data} onEdit={onEdit} onDelete={remove} pendingDelete={pendingDelete} /></Card></div>;
}
function TransactionList({ items, data, compact, onEdit, onDelete, pendingDelete }: { items: LedgerTransaction[]; data: LedgerSnapshot; compact?: boolean; onEdit?: (tx: LedgerTransaction) => void; onDelete?: (id: string) => void; pendingDelete?: string | null }) {
  if (!items.length) return <Empty text="还没有符合条件的流水" />;
  return <div className="transaction-list">{items.map((tx) => { const category = data.categories.find((c) => c.id === tx.categoryId); const account = data.accounts.find((a) => a.id === tx.accountId); const incoming = ["income", "refund", "loan_repayment", "salary_payment"].includes(tx.type); return <div className="transaction" key={tx.id}><div className={`tx-icon ${incoming ? "in" : "out"}`}>{incoming ? <ArrowDownLeft /> : tx.type === "transfer" ? <ArrowRightLeft /> : <ArrowUpRight />}</div><div className="tx-copy"><strong>{category?.name ?? typeLabels[tx.type]}</strong><span>{tx.merchant || tx.note || account?.name}<small>{tx.date} {tx.time} · {account?.name}</small></span></div><div className="tx-amount"><strong className={incoming ? "positive" : tx.type === "transfer" ? "" : "negative"}>{incoming ? "+" : tx.type === "transfer" ? "" : "−"}{formatMoney(tx.amountCents)}</strong>{tx.countsTowardBudget && <small>计入预算</small>}</div>{!compact && <div className="row-actions"><button onClick={() => onEdit?.(tx)}>编辑</button><button className={pendingDelete === tx.id ? "danger solid" : "danger"} onClick={() => onDelete?.(tx.id)}><Trash2 />{pendingDelete === tx.id ? "确认" : "删除"}</button></div>}</div>; })}</div>;
}

function QuickEntry({ data, editing, onDone, onCancel }: { data: LedgerSnapshot; editing: LedgerTransaction | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<TransactionType>(editing?.type ?? "expense"); const [amount, setAmount] = useState(editing ? String(editing.amountCents / 100) : "");
  const [date, setDate] = useState<LocalDate>(editing?.date ?? TODAY); const [time, setTime] = useState(editing?.time ?? new Date().toTimeString().slice(0, 5));
  const [accountId, setAccountId] = useState(editing?.accountId ?? data.accounts[0]?.id); const [toAccountId, setToAccountId] = useState(editing?.toAccountId ?? data.accounts[1]?.id);
  const relevant = data.categories.filter((c) => c.kind === (["income", "refund", "loan_repayment", "salary_payment"].includes(type) ? "income" : "expense") && c.parentId && !c.archived);
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? relevant[0]?.id); const [merchant, setMerchant] = useState(editing?.merchant ?? ""); const [note, setNote] = useState(editing?.note ?? ""); const [attachment, setAttachment] = useState<File | null>(null);
  const [budget, setBudget] = useState(editing?.countsTowardBudget ?? type === "expense"); const [rigid, setRigid] = useState(editing?.rigid ?? false); const [reimbursable, setReimbursable] = useState(editing?.reimbursable ?? false); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); const amountCents = asCents(Number(amount));
    if (!Number.isFinite(amountCents) || amountCents <= 0) { setError("请输入大于 0 的有效金额"); return; }
    if (type === "transfer" && accountId === toAccountId) { setError("转入与转出账户不能相同"); return; }
    if (attachment && (!attachment.type.startsWith("image/") || attachment.size > 5 * 1024 * 1024)) { setError("凭证需为 5MB 以内的图片"); return; }
    setSaving(true); const attachmentIds = [...(editing?.attachmentIds ?? [])];
    if (attachment) { const id = uid("attachment"); await db.attachments.add({ id, name: attachment.name, type: attachment.type, size: attachment.size, blob: attachment }); await queueLocalChange("attachments", id); attachmentIds.push(id); }
    const tx: LedgerTransaction = { id: editing?.id ?? uid("tx"), type, status: "posted", amountCents, date, time, accountId, toAccountId: type === "transfer" ? toAccountId : undefined, categoryId: type === "transfer" ? undefined : categoryId, merchant: merchant.trim(), note: note.trim(), countsTowardBudget: type === "expense" && budget, rigid, reimbursable, tags: editing?.tags ?? [], attachmentIds, affectsBalance: true, createdAt: editing?.createdAt ?? new Date().toISOString() };
    await db.transactions.put(tx); await queueLocalChange("transactions", tx.id); setSaving(false); await onDone();
  };
  return <div className="entry-layout"><form className="entry-card" onSubmit={save}><div className="entry-tabs">{(["expense", "income", "transfer", "refund", "loan_out", "loan_repayment"] as TransactionType[]).map((item) => <button type="button" className={type === item ? "active" : ""} key={item} onClick={() => setType(item)}>{typeLabels[item]}</button>)}</div><label className="amount-input"><span>金额</span><div><b>¥</b><input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></div></label>{error && <p className="form-error">{error}</p>}<div className="form-grid"><label>日期<input type="date" value={date} onChange={(e) => setDate(e.target.value as LocalDate)} /></label><label>时间<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label><label>账户<select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{data.accounts.filter((a) => !a.hidden).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{type === "transfer" ? <label>转入账户<select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>{data.accounts.filter((a) => !a.hidden).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label> : <label>分类<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{relevant.map((c) => <option key={c.id} value={c.id}>{data.categories.find((p) => p.id === c.parentId)?.name} / {c.name}</option>)}</select></label>}<label>商家或来源<input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="选填" /></label><label className="wide">备注<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="写点什么…" /></label><label className="wide">图片凭证（最大 5MB）<input type="file" accept="image/*" onChange={(e) => setAttachment(e.target.files?.[0] ?? null)} /></label></div><div className="switches"><label><input type="checkbox" checked={budget} onChange={(e) => setBudget(e.target.checked)} disabled={type !== "expense"} /><span />计入自由预算</label><label><input type="checkbox" checked={rigid} onChange={(e) => setRigid(e.target.checked)} /><span />刚性支出</label><label><input type="checkbox" checked={reimbursable} onChange={(e) => setReimbursable(e.target.checked)} /><span />可报销</label></div><div className="form-actions"><button type="button" className="secondary" onClick={onCancel}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : editing ? "保存修改" : "确认记账"}</button></div></form><aside className="entry-tip"><ShieldCheck /><h3>这笔钱会怎么算？</h3><p>只有已到账的收入会增加当前余额。转账只改变账户分布，不计作收入或支出。凭证会先安全保存在本机，再按分块增量同步。</p></aside></div>;
}

function BudgetView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const [amount, setAmount] = useState("100"); const simulation = simulatePurchase(asCents(Number(amount) || 0), m.balance, m.safety.totalCents, m.weekly.remainingCents, m.installments.next?.amountCents ?? 0);
  const saveCap = async (value: string) => { const cents = asCents(Number(value)); if (cents < 0) return; await db.budgets.update("main", { weeklyCapCents: cents }); await queueLocalChange("budgets", "main"); await onRefresh(); setToast("预算上限已更新"); };
  return <div className="page-stack"><section className="budget-hero"><div><p>本周安全预算</p><h2>{formatMoney(m.weekly.budgetCents)}</h2><span>已花 {formatMoney(m.weekly.spentCents)}，还剩 {formatMoney(m.weekly.remainingCents)}</span></div><div className="budget-edit"><label>每周上限<input type="number" defaultValue={data.budget.weeklyCapCents / 100} onBlur={(e) => saveCap(e.target.value)} /></label><small>自动建议不会超过此金额</small></div></section><div className="content-grid"><Card title="预算执行"><BudgetMini weekly={m.weekly} /><div className="category-bars">{Object.entries(data.budget.categoryLimits).map(([name, limit], index) => { const spent = data.transactions.filter((t) => t.countsTowardBudget && data.categories.find((c) => c.id === t.categoryId)?.name === name).reduce((s, t) => s + t.amountCents, 0); return <div key={name}><div><span>{name}</span><strong>{formatMoney(spent)} / {formatMoney(limit)}</strong></div><div className="progress thin"><i style={{ width: `${Math.min(100, spent / limit * 100)}%`, background: palette[index % palette.length] }} /></div></div>; })}</div></Card><Card title="消费前先算一算"><label className="sim-input">计划消费金额<div><b>¥</b><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div></label><div className={`recommendation ${simulation.recommended ? "yes" : "no"}`}><strong>{simulation.recommended ? "现金流允许购买" : "建议暂缓购买"}</strong><span>{simulation.safetyGapCents > 0 ? `消费后将低于安全线 ${formatMoney(simulation.safetyGapCents)}` : "消费后不会跌破安全线"}</span></div><div className="simulation-grid"><div><span>本周剩余</span><strong>{formatMoney(simulation.afterWeeklyCents)}</strong></div><div><span>账户余额</span><strong>{formatMoney(simulation.afterBalanceCents)}</strong></div><div><span>分期覆盖</span><strong>{simulation.installmentCovered ? "可以覆盖" : "存在风险"}</strong></div></div></Card></div></div>;
}

function SalaryView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const plan = data.salaryPlans[0]; const expected = plan ? salaryExpectedPayments(plan, data.attendance) : [];
  const toggle = async (id: string, worked: boolean) => { await db.attendance.update(id, { status: worked ? "worked" : "off", earnedCents: worked ? plan.dailyRateCents : 0 }); await queueLocalChange("attendance", id); await onRefresh(); };
  const confirmPaid = async () => { if (!m.salary.receivableCents) return; const id = uid("salary"); await db.transactions.add({ id, type: "salary_payment", status: "posted", amountCents: m.salary.receivableCents, date: TODAY, time: new Date().toTimeString().slice(0, 5), accountId: data.accounts[0].id, categoryId: "income-工资-暑假工工资", merchant: plan.employer, note: "手动确认工资到账", countsTowardBudget: false, rigid: false, reimbursable: false, tags: ["工资"], attachmentIds: [], affectsBalance: true, createdAt: new Date().toISOString() }); await queueLocalChange("transactions", id); await onRefresh(); setToast("工资已转为到账收入"); };
  return <div className="page-stack"><section className="salary-cards"><MetricCard icon={<BriefcaseBusiness />} label="累计已赚" value={formatMoney(m.salary.earnedCents)} sub="按实际出勤计算" tone="blue" /><MetricCard icon={<Bell />} label="尚未到账" value={formatMoney(m.salary.receivableCents)} sub="不计入可消费余额" tone="violet" /><MetricCard icon={<CalendarDays />} label="未来预计工资" value={formatMoney(m.salary.futureCents)} sub={`计划至 ${plan?.endDate}`} tone="green" /></section><div className="content-grid"><Card title="工资计划"><div className="plan-details"><div><span>工作</span><strong>{plan.employer}</strong></div><div><span>工作期间</span><strong>{plan.startDate} — {plan.endDate}</strong></div><div><span>日薪</span><strong>{formatMoney(plan.dailyRateCents)}</strong></div><div><span>结算规则</span><strong>每月 {plan.cutoffDay} 日截止，{plan.payDay} 日发薪</strong></div></div><button className="primary full" disabled={!m.salary.receivableCents} onClick={confirmPaid}><Check />确认应收工资已到账</button></Card><Card title="预计发薪批次"><div className="timeline">{expected.map((item) => <div key={item.date}><i /><div><strong>{item.date}</strong><span>预计到账</span></div><b>{formatMoney(item.amountCents)}</b></div>)}</div></Card></div><Card title="每日考勤"><div className="attendance-grid">{data.attendance.map((item) => <button key={item.id} className={item.status === "worked" ? "worked" : "off"} onClick={() => toggle(item.id, item.status !== "worked")}><span>{item.date.slice(5)}</span><strong>{item.status === "worked" ? "出勤" : "休息"}</strong><small>{formatMoney(item.earnedCents)}</small></button>)}</div></Card></div>;
}

function InstallmentsView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const pay = async (id: string) => { const item = data.installmentItems.find((i) => i.id === id); if (!item) return; const transactionId = uid("installment"); await db.transaction("rw", [db.installmentItems, db.transactions], async () => { await db.installmentItems.update(id, { status: "paid", actualPaidDate: TODAY }); await db.transactions.add({ id: transactionId, type: "installment_payment", status: "posted", amountCents: item.amountCents, date: TODAY, time: new Date().toTimeString().slice(0, 5), accountId: data.installmentPlans[0].accountId, categoryId: data.installmentPlans[0].categoryId, merchant: data.installmentPlans[0].name, note: `第 ${item.sequence} 期付款`, countsTowardBudget: false, rigid: true, reimbursable: false, tags: ["分期"], attachmentIds: [], linkedId: item.id, affectsBalance: true, createdAt: new Date().toISOString() }); }); await queueLocalChange("installmentItems", id); await queueLocalChange("transactions", transactionId); await onRefresh(); setToast("本期已标记为还款"); };
  return <div className="page-stack"><section className="installment-hero"><div><p>PS课程分期</p><h2>{formatMoney(m.installments.remainingCents)}</h2><span>剩余 {m.installments.remainingCount} 期</span></div><div><span>下次还款</span><strong>{m.installments.next?.dueDate}</strong><b>{m.installments.next ? formatMoney(m.installments.next.amountCents) : "已结清"}</b></div></section><section className="pressure-grid"><div><span>未来30天</span><strong>{formatMoney(m.installments.pressure30Cents)}</strong></div><div><span>未来60天</span><strong>{formatMoney(m.installments.pressure60Cents)}</strong></div><div><span>未来90天</span><strong>{formatMoney(m.installments.pressure90Cents)}</strong></div></section><Card title="还款时间轴"><div className="installment-list">{data.installmentItems.map((item) => <div key={item.id} className={item.status}><div className="installment-no">{item.status === "paid" ? <Check /> : item.sequence}</div><div><strong>第 {item.sequence} 期</strong><span>{item.dueDate}{item.historicalSnapshot ? " · 余额快照前" : ""}</span></div><b>{formatMoney(item.amountCents)}</b><span className={`badge ${item.reserved ? "reserved" : ""}`}>{item.status === "paid" ? "已还" : item.reserved ? "已预留" : "待还"}</span>{item.status === "unpaid" && <button onClick={() => pay(item.id)}>还款</button>}</div>)}</div></Card></div>;
}

function CalendarView({ data, metrics: m }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics> }) {
  const [selected, setSelected] = useState<LocalDate>("2026-08-15"); const monthStart = "2026-08-01" as LocalDate; const firstDay = new Date(2026, 7, 1).getDay(); const days = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}` as LocalDate);
  const eventsFor = (date: LocalDate) => ({ income: m.expectedIncome.filter((x) => x.date === date).reduce((s, x) => s + x.amountCents, 0), installment: data.installmentItems.filter((i) => i.dueDate === date && i.status === "unpaid").reduce((s, i) => s + i.amountCents, 0), transactions: data.transactions.filter((t) => t.date === date) });
  const selectedEvents = eventsFor(selected); const forecast = forecastCashflow({ targetDate: selected, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, includeExpectedIncome: true });
  return <div className="calendar-layout"><Card title="2026 年 8 月"><div className="calendar-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div className="calendar-grid">{Array.from({ length: firstDay }).map((_, i) => <i key={`blank-${i}`} />)}{days.map((date) => { const events = eventsFor(date); return <button className={selected === date ? "selected" : ""} key={date} onClick={() => setSelected(date)}><strong>{Number(date.slice(-2))}</strong><span>{events.income > 0 && <i className="event-in" />}{events.installment > 0 && <i className="event-out" />}</span><small>{events.income ? `+${Math.round(events.income / 100)}` : events.installment ? `-${Math.round(events.installment / 100)}` : ""}</small></button>; })}</div></Card><aside className="day-panel"><p>{selected}</p><h2>预计余额</h2><strong>{formatMoney(forecast.balanceCents)}</strong><div><span>预计到账</span><b className="positive">+{formatMoney(selectedEvents.income)}</b></div><div><span>分期到期</span><b className="negative">−{formatMoney(selectedEvents.installment)}</b></div><div><span>预计自由资金</span><b>{formatMoney(Math.max(0, forecast.balanceCents - m.safety.totalCents))}</b></div><Insight icon={<CalendarDays />} text="蓝点代表预计收入，橙点代表分期或刚性支出。预测不会修改实际余额。" /></aside></div>;
}

function AnalyticsView({ data }: { data: LedgerSnapshot }) {
  const posted = data.transactions.filter((t) => t.status === "posted" && t.affectsBalance && t.type !== "transfer");
  const expense = posted.filter((t) => ["expense", "installment_payment", "loan_out"].includes(t.type)).reduce((s, t) => s + t.amountCents, 0);
  const income = posted.filter((t) => ["income", "salary_payment", "loan_repayment"].includes(t.type)).reduce((s, t) => s + t.amountCents, 0);
  const byCategory = new Map<string, number>(); posted.filter((t) => t.type === "expense").forEach((t) => { const name = data.categories.find((c) => c.id === t.categoryId)?.name ?? "其他"; byCategory.set(name, (byCategory.get(name) ?? 0) + t.amountCents / 100); });
  const pie = [...byCategory].map(([name, value]) => ({ name, value })); const trend = ["第1周", "第2周", "第3周", "第4周"].map((name, index) => ({ name, 支出: index === 2 ? expense / 100 : 0, 预算: data.budget.weeklyCapCents / 100 }));
  return <div className="page-stack"><section className="analytics-metrics"><div><span>本月收入</span><strong className="positive">{formatMoney(income)}</strong></div><div><span>本月支出</span><strong className="negative">{formatMoney(expense)}</strong></div><div><span>净结余</span><strong>{formatMoney(income - expense)}</strong></div><div><span>日均消费</span><strong>{formatMoney(Math.round(expense / 31))}</strong></div></section><div className="content-grid"><Card title="每周消费趋势"><div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><defs><linearGradient id="trend" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#22a6b3" stopOpacity={0.5}/><stop offset="100%" stopColor="#22a6b3" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis /><Tooltip /><Area dataKey="支出" stroke="#138697" fill="url(#trend)" /></AreaChart></ResponsiveContainer></div></Card><Card title="分类支出占比">{pie.length ? <div className="chart pie"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85}>{pie.map((_, index) => <Cell key={index} fill={palette[index % palette.length]} />)}</Pie><Tooltip formatter={(v) => `¥${Number(v).toFixed(2)}`} /></PieChart></ResponsiveContainer></div> : <Empty text="记录支出后会在这里生成图表" />}</Card></div></div>;
}

function AccountsView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const [name, setName] = useState(""); const [balance, setBalance] = useState("");
  const add = async () => { if (!name.trim()) return; const id = uid("acc"); await db.accounts.add({ id, name: name.trim(), icon: "WalletCards", openingBalanceCents: asCents(Number(balance) || 0), balanceAsOf: TODAY, hidden: false, sort: data.accounts.length + 1 }); await queueLocalChange("accounts", id); setName(""); setBalance(""); await onRefresh(); setToast("账户已添加"); };
  const adjust = async (id: string, current: Cents) => { const value = window.prompt("输入新的余额快照（元）", String(current / 100)); if (value === null) return; const cents = asCents(Number(value)); if (!Number.isFinite(cents)) { setToast("金额格式无效"); return; } await db.accounts.update(id, { openingBalanceCents: cents, balanceAsOf: TODAY }); await queueLocalChange("accounts", id); await onRefresh(); setToast("账户余额快照已调整"); };
  return <div className="page-stack"><section className="account-total"><span>全部账户余额</span><strong>{formatMoney(m.balance)}</strong><small>{data.accounts.filter((a) => !a.hidden).length} 个可见账户</small></section><div className="account-grid">{data.accounts.map((account) => <article key={account.id}><div className="account-icon"><WalletCards /></div><div><span>{account.name}</span><strong>{formatMoney(m.balances[account.id] ?? 0)}</strong><small>余额基准日 {account.balanceAsOf}</small></div><div className="account-actions"><button onClick={() => adjust(account.id, m.balances[account.id] ?? 0)}>调整</button><button onClick={async () => { await db.accounts.update(account.id, { hidden: !account.hidden }); await queueLocalChange("accounts", account.id); await onRefresh(); }}>{account.hidden ? "显示" : "隐藏"}</button></div></article>)}</div><Card title="新增账户"><div className="inline-form"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="账户名称" /><input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="当前余额" /><button className="primary" onClick={add}><Plus />添加账户</button></div></Card></div>;
}

function SettingsView({ data, theme, setTheme, onRefresh, setToast }: { data: LedgerSnapshot; theme: string; setTheme: (t: "light" | "dark") => void; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const cloud = useCloudSync();
  const [clearText, setClearText] = useState(""); const [importInfo, setImportInfo] = useState<{ text: string; accounts: number; transactions: number } | null>(null);
  const exportJson = async () => downloadText(`青蓝账本-${TODAY}.json`, await exportBackup(), "application/json");
  const previewImport = async (file?: File) => { if (!file) return; const text = await file.text(); try { const value = JSON.parse(text); if (value.schemaVersion !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.transactions)) throw new Error(); setImportInfo({ text, accounts: value.accounts.length, transactions: value.transactions.length }); } catch { setToast("备份文件格式无效"); } };
  const runImport = async (mode: "merge" | "replace") => { if (!importInfo) return; await importBackup(importInfo.text, mode); setImportInfo(null); await onRefresh(); setToast(mode === "merge" ? "备份已合并" : "备份已恢复"); };
  const queueBudget = async () => { await queueLocalChange("budgets", "main"); await onRefresh(); };
  const lastSync = cloud.state.lastSyncedAt ? new Date(cloud.state.lastSyncedAt).toLocaleString("zh-CN") : "尚未完成";
  return <div className="settings-grid">
    <section className="settings-section wide cloud-account-section"><h2>账号与云同步</h2>{cloud.configured && cloud.user ? <div className="cloud-account"><div className="cloud-profile">{cloud.user.photoURL ? <img src={cloud.user.photoURL} alt="Google 头像" /> : <div className="profile-fallback">青</div>}<div><strong>{cloud.user.displayName || "Google 用户"}</strong><span>{cloud.user.email}</span><small>最后同步：{lastSync}</small></div></div><div className="cloud-controls"><SyncStatusGlyph /><button onClick={() => void cloud.syncNow()}><RefreshCw />立即同步</button><button className="danger" onClick={() => void cloud.logout()}><LogOut />退出登录</button></div></div> : <div className="firebase-needed"><ShieldCheck /><div><strong>当前为本地安全模式</strong><p>在部署环境填写 <code>VITE_FIREBASE_*</code>，并在 Firebase 控制台启用 Google 登录与 Firestore 后，即可自动出现登录页并迁移旧数据。</p></div></div>}</section>
    <section className="settings-section"><h2>预算与安全线</h2><SettingRow label="安全线范围" hint="决定哪些近期分期计入锁定资金"><select value={data.budget.safetyMode} onChange={async (e) => { await db.budgets.update("main", { safetyMode: e.target.value as typeof data.budget.safetyMode }); await queueBudget(); }}><option value="30d">未来30天</option><option value="60d">未来60天</option><option value="school">计算到开学</option><option value="custom">自定义金额</option></select></SettingRow><SettingRow label="每周结余" hint="决定结余是否滚入下周"><select value={data.budget.rolloverMode} onChange={async (e) => { await db.budgets.update("main", { rolloverMode: e.target.value as "rollover" | "reset" }); await queueBudget(); }}><option value="reset">每周清零</option><option value="rollover">结余滚存</option></select></SettingRow><SettingRow label="开学日期" hint="用于安全线和未来预测"><input type="date" value={data.budget.schoolDate} onChange={async (e) => { await db.budgets.update("main", { schoolDate: e.target.value as LocalDate }); await queueBudget(); }} /></SettingRow></section>
    <section className="settings-section"><h2>显示与隐私</h2><SettingRow label="界面主题" hint="登录后会同步到所有设备"><div className="theme-toggle"><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}><Sun />浅色</button><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}><Moon />深色</button></div></SettingRow><SettingRow label="本地缓存" hint="离线时仍可读写，联网后自动补传"><span className="local-badge"><ShieldCheck />IndexedDB 已启用</span></SettingRow></section>
    <section className="settings-section wide"><h2>备份与恢复</h2><div className="backup-actions"><button onClick={exportJson}><Download />导出完整 JSON</button><button onClick={() => downloadText(`青蓝流水-${TODAY}.csv`, exportTransactionsCsv(data.transactions, data.accounts, data.categories), "text/csv;charset=utf-8")}><Download />导出流水 CSV</button><label className="button-label"><FileUp />导入 JSON<input type="file" accept="application/json" onChange={(e) => previewImport(e.target.files?.[0])} /></label></div>{importInfo && <div className="import-preview"><div><strong>导入预览</strong><span>{importInfo.accounts} 个账户 · {importInfo.transactions} 条流水</span><p>合并会按 ID 更新同名记录；覆盖会先清除当前账本。导入后的变化会进入增量同步队列。</p></div><button onClick={() => runImport("merge")}>合并导入</button><button className="danger" onClick={() => runImport("replace")}>覆盖恢复</button></div>}</section>
    <section className="settings-section wide danger-zone"><h2>危险操作</h2><p>输入“清空数据”后可恢复首次示例数据。登录状态下，删除与恢复结果也会同步到其他设备。</p><div className="inline-form"><input value={clearText} onChange={(e) => setClearText(e.target.value)} placeholder="输入：清空数据" /><button className="danger solid" disabled={clearText !== "清空数据"} onClick={async () => { await resetDatabase(); setClearText(""); await onRefresh(); setToast("已恢复示例数据并加入同步队列"); }}><RotateCcw />清空并恢复示例</button></div></section>
  </div>;
}
function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong><span>{hint}</span></div>{children}</div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><ReceiptText /><p>{text}</p></div>; }
