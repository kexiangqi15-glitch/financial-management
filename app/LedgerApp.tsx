"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ArrowDownLeft, ArrowRightLeft, ArrowUpRight, BarChart3, Bell, BriefcaseBusiness, CalendarDays, Check,
  CalendarClock, ChevronLeft, ChevronRight, CircleDollarSign, Download, FileUp, Home, Landmark, Menu, Moon, MoreHorizontal, Plus,
  ReceiptText, RotateCcw, Search, Settings, ShieldAlert, ShieldCheck, Sparkles, Sun, Trash2, WalletCards, X, Zap, LogOut, RefreshCw,
} from "lucide-react";
import { db, exportBackup, exportMonthlyTransactionsCsv, exportTransactionsCsv, getDeviceId, importBackup, initializeDatabase, loadSnapshot, queueLocalChange, resetDatabase } from "@/lib/db";
import {
  calculateAccountBalances, calculateSafetyLine, calculateSalarySnapshot, calculateWeeklyBudget, currentAvailable,
  addDays, dailyConsumptionTrend, forecastCashflow, monthBounds, monthlyCategorySpendingTrend, monthlyFinanceSummary,
  recurringOccurrences, salaryExpectedPayments, simulatePurchase, summarizeInstallments, toLocalDate, weekBounds, weeklySpent,
} from "@/lib/calculations";
import type { Attendance, Cents, LedgerSnapshot, LedgerTransaction, LocalDate, TransactionType } from "@/lib/types";
import { asCents, formatMoney, uid } from "@/lib/types";
import { previewTransactionCsv } from "@/lib/csv-import";
import { buildAiAnalysisInput, isAiAnalysisResponse, parseAiAnalysisHttpResponse, type AiAnalysisResponse } from "@/lib/ai-analysis";
import {
  attendanceStatusLabel, confirmSalarySettlement, ensureLegacySalarySettlements, setAttendanceStatus, setSalaryEndDate,
} from "@/lib/salary";
import { SyncStatusGlyph, useCloudSync } from "./CloudSyncProvider";
import { PlanningView } from "./PlanningView";
import { cloudApiUrl, cloudCredentials, cloudHeaders, getExternalSyncCode } from "@/lib/cloud-api";

type View = "home" | "transactions" | "add" | "budget" | "salary" | "installments" | "planning" | "calendar" | "analytics" | "accounts" | "settings";
const TODAY = toLocalDate(new Date());
const typeLabels: Record<TransactionType, string> = {
  expense: "支出", income: "收入", transfer: "转账", refund: "退款", loan_out: "借出", loan_repayment: "收回",
  salary_payment: "工资到账", installment_payment: "分期付款", adjustment: "余额调整",
};
const palette = ["#22c7c9", "#3b82f6", "#8b7cf6", "#55c995", "#f2a65a", "#ef6f8f", "#49a6dd", "#b385d8", "#e3c34f", "#5cc0a7", "#f07f58", "#7799e8"];

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
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
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

  const title: Record<View, string> = { home: "现金流总览", transactions: "交易流水", add: editing ? "编辑记录" : "记一笔", budget: "预算管理", salary: "工资与应收", installments: "分期管理", planning: "财务计划", calendar: "现金流日历", analytics: "统计分析", accounts: "账户与对账", settings: "设置与备份" };

  return <div className="app-shell">
    <Sidebar view={view} navigate={navigate} />
    <main className="main">
      <header className="topbar">
        <div><p className="eyebrow">{TODAY.slice(0, 4)} 个人现金流计划</p><h1>{title[view]}</h1></div>
        <div className="top-actions"><SyncStatusGlyph /><button className="icon-btn" aria-label="切换主题" onClick={() => void changeTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? <Moon /> : <Sun />}</button><button className="avatar account-avatar" onClick={() => navigate("settings")}>{cloud.user?.photoURL ? <img src={cloud.user.photoURL} alt={cloud.user.displayName || "账号头像"} /> : "青"}</button></div>
      </header>
      {view === "home" && <Dashboard data={data} metrics={metrics} navigate={navigate} />}
      {view === "transactions" && <Transactions data={data} onRefresh={refresh} onEdit={(tx) => { setEditing(tx); setView("add"); }} setToast={setToast} />}
      {view === "add" && <QuickEntry data={data} editing={editing} onDone={async () => { await refresh(); setEditing(null); setToast(editing ? "记录已更新" : "已记入账本"); navigate("transactions"); }} onCancel={() => navigate("transactions")} />}
      {view === "budget" && <BudgetView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "salary" && <SalaryView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "installments" && <InstallmentsView data={data} metrics={metrics} onRefresh={refresh} setToast={setToast} />}
      {view === "planning" && <PlanningView data={data} onRefresh={refresh} setToast={setToast} />}
      {view === "calendar" && <CalendarView data={data} metrics={metrics} />}
      {view === "analytics" && <AnalyticsView data={data} setToast={setToast} />}
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
  const safety = calculateSafetyLine(data.reserves, data.installmentItems, data.budget, TODAY, data.financialGoals);
  const expectedIncome = data.salaryPlans.flatMap((p) => salaryExpectedPayments(p, data.attendance));
  const nextIncome = expectedIncome.find((x) => x.date >= TODAY);
  const spent = weeklySpent(data.transactions, TODAY, data.budget.weekStartsOn);
  const weekly = calculateWeeklyBudget({ availableCents: balance, safetyCents: safety.totalCents, nextIncomeDate: nextIncome?.date, asOf: TODAY, settings: data.budget, spentCents: spent });
  const installments = summarizeInstallments(data.installmentItems, TODAY);
  return { balance, balances, salary, safety, expectedIncome, nextIncome, weekly, installments, free: Math.max(0, balance - safety.totalCents), gap: Math.max(0, safety.totalCents - balance) };
}

const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home }, { id: "transactions", label: "账单", icon: ReceiptText }, { id: "budget", label: "预算", icon: ShieldCheck },
  { id: "salary", label: "工资", icon: BriefcaseBusiness }, { id: "installments", label: "分期", icon: CalendarDays }, { id: "planning", label: "计划", icon: CalendarClock }, { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "analytics", label: "统计", icon: BarChart3 }, { id: "accounts", label: "账户", icon: Landmark }, { id: "settings", label: "设置", icon: Settings },
];
function Sidebar({ view, navigate }: { view: View; navigate: (view: View) => void }) {
  const { configured } = useCloudSync();
  return <aside className="sidebar"><div className="brand"><div className="brand-mark">青</div><div><strong>青蓝账本</strong><small>放心花每一笔钱</small></div></div><nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => navigate(id)}><Icon />{label}</button>)}</nav><div className="privacy"><ShieldCheck /><div><strong>{configured ? "本地优先云同步" : "本地安全模式"}</strong><span>{configured ? "IndexedDB · D1 · 可离线" : "账目已安全保存在本机"}</span></div></div></aside>;
}
function MobileNav({ view, navigate }: { view: View; navigate: (view: View) => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primaryItems: { id: View; label: string; icon: typeof Home }[] = [{ id: "home", label: "首页", icon: Home }, { id: "transactions", label: "账单", icon: ReceiptText }, { id: "add", label: "记一笔", icon: Plus }, { id: "budget", label: "预算", icon: ShieldCheck }];
  const moreItems = [
    { id: "salary" as View, label: "工资与应收", icon: BriefcaseBusiness },
    { id: "installments" as View, label: "分期管理", icon: CalendarDays },
    { id: "planning" as View, label: "财务计划", icon: CalendarClock },
    { id: "calendar" as View, label: "现金流日历", icon: CalendarDays },
    { id: "analytics" as View, label: "统计分析", icon: BarChart3 },
    { id: "accounts" as View, label: "账户管理", icon: Landmark },
    { id: "settings" as View, label: "设置与备份", icon: Settings },
  ];
  const moreActive = moreItems.some((item) => item.id === view);
  useEffect(() => {
    if (!moreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [moreOpen]);
  const openView = (next: View) => { setMoreOpen(false); navigate(next); };
  return <>
    {moreOpen && <button className="mobile-more-backdrop" aria-label="关闭更多页面菜单" onClick={() => setMoreOpen(false)} />}
    {moreOpen && <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="更多页面">
      <div className="mobile-more-head"><div><strong>全部功能</strong><span>选择要打开的页面</span></div><button aria-label="关闭更多页面菜单" onClick={() => setMoreOpen(false)}><X /></button></div>
      <div className="mobile-more-grid">{moreItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => openView(id)}><Icon /><span>{label}</span><ChevronRight /></button>)}</div>
    </section>}
    <nav className="mobile-nav" aria-label="手机端主导航">
      {primaryItems.map(({ id, label, icon: Icon }) => <button key={id} className={`${view === id ? "active" : ""} ${id === "add" ? "add" : ""}`} onClick={() => openView(id)}><Icon /><span>{label}</span></button>)}
      <button className={moreActive || moreOpen ? "active" : ""} aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal /><span>更多</span></button>
    </nav>
  </>;
}

function Dashboard({ data, metrics: m, navigate }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; navigate: (v: View) => void }) {
  const forecastDates = [
    ...m.expectedIncome.map((item) => item.date),
    ...data.installmentItems.filter((item) => item.status === "unpaid").map((item) => item.dueDate),
    addDays(TODAY, 30),
    data.budget.schoolDate,
    data.budget.customForecastDate,
  ].filter((date, index, all) => date >= TODAY && all.indexOf(date) === index).sort().slice(0, 5) as LocalDate[];
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
    <Card title="未来资金预测" action="现金流日历" onAction={() => navigate("calendar")}><div className="forecast-table"><div className="forecast-head"><span>日期</span><span>保守余额</span><span>工资按期到账</span><span>自由资金</span></div>{forecastDates.map((date) => { const conservative = forecastCashflow({ targetDate: date, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, recurringRules: data.recurringRules, includeExpectedIncome: false }); const expected = forecastCashflow({ targetDate: date, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, recurringRules: data.recurringRules, includeExpectedIncome: true }); return <div className="forecast-row" key={date}><span>{date.slice(5).replace("-", "月")}日</span><strong>{formatMoney(conservative.balanceCents)}</strong><strong>{formatMoney(expected.balanceCents)}</strong><span className={expected.balanceCents - m.safety.totalCents < 0 ? "negative" : "positive"}>{formatMoney(Math.max(0, expected.balanceCents - m.safety.totalCents))}</span></div>; })}</div></Card>
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
  const period = data.budget.budgetPeriod ?? "weekly";
  const periodBounds = period === "monthly" ? monthBounds(TODAY.slice(0, 7)) : period === "custom"
    ? { start: data.budget.customBudgetStart ?? TODAY, end: data.budget.customBudgetEnd ?? TODAY }
    : weekBounds(TODAY, data.budget.weekStartsOn);
  const saveBudgetPeriod = async (value: "weekly" | "monthly" | "custom") => {
    await db.budgets.update("main", { budgetPeriod: value });
    await queueLocalChange("budgets", "main");
    await onRefresh();
  };
  const saveCategoryLimit = async (name: string, value: string) => {
    const limit = Math.max(0, asCents(Number(value)));
    await db.budgets.update("main", { categoryLimits: { ...data.budget.categoryLimits, [name]: limit } });
    await queueLocalChange("budgets", "main");
    await onRefresh();
    setToast(`${name}预算已更新`);
  };
  return <div className="page-stack"><section className="budget-hero"><div><p>本周安全预算</p><h2>{formatMoney(m.weekly.budgetCents)}</h2><span>已花 {formatMoney(m.weekly.spentCents)}，还剩 {formatMoney(m.weekly.remainingCents)}</span></div><div className="budget-edit"><label>每周上限<input type="number" defaultValue={data.budget.weeklyCapCents / 100} onBlur={(event) => saveCap(event.target.value)} /></label><small>自动建议不会超过此金额</small></div></section><div className="budget-period"><label>分类预算周期<select value={period} onChange={(event) => saveBudgetPeriod(event.target.value as typeof period)}><option value="weekly">本周</option><option value="monthly">本月</option><option value="custom">自定义</option></select></label>{period === "custom" && <><input type="date" value={data.budget.customBudgetStart ?? TODAY} onChange={async (event) => { await db.budgets.update("main", { customBudgetStart: event.target.value as LocalDate }); await queueLocalChange("budgets", "main"); await onRefresh(); }} /><input type="date" value={data.budget.customBudgetEnd ?? TODAY} onChange={async (event) => { await db.budgets.update("main", { customBudgetEnd: event.target.value as LocalDate }); await queueLocalChange("budgets", "main"); await onRefresh(); }} /></>}</div><div className="content-grid"><Card title="预算执行"><BudgetMini weekly={m.weekly} /><div className="category-bars editable">{Object.entries(data.budget.categoryLimits).map(([name, limit], index) => {
    const matchingCategoryIds = new Set(data.categories.filter((category) => {
      const parent = data.categories.find((candidate) => candidate.id === category.parentId);
      return category.name === name || parent?.name === name;
    }).map((category) => category.id));
    const spent = data.transactions.filter((transaction) => transaction.status === "posted" && transaction.countsTowardBudget && transaction.date >= periodBounds.start && transaction.date <= periodBounds.end && matchingCategoryIds.has(transaction.categoryId ?? "")).reduce((sum, transaction) => sum + (transaction.type === "refund" ? -transaction.amountCents : transaction.amountCents), 0);
    const percent = limit ? Math.max(0, Math.round(spent / limit * 100)) : 0;
    return <div key={name} className={percent >= 100 ? "over" : percent >= 90 ? "danger-near" : percent >= 70 ? "warning-near" : ""}><div><span>{name}<small>{percent >= 100 ? "已超支" : percent >= 90 ? "接近上限" : percent >= 70 ? "需要注意" : ""}</small></span><label><strong>{formatMoney(spent)} /</strong><input type="number" defaultValue={limit / 100} onBlur={(event) => saveCategoryLimit(name, event.target.value)} /></label></div><div className="progress thin"><i style={{ width: `${Math.min(100, percent)}%`, background: palette[index % palette.length] }} /></div></div>;
  })}</div></Card><Card title="消费前先算一算"><label className="sim-input">计划消费金额<div><b>¥</b><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label><div className={`recommendation ${simulation.recommended ? "yes" : "no"}`}><strong>{simulation.recommended ? "现金流允许购买" : "建议暂缓购买"}</strong><span>{simulation.safetyGapCents > 0 ? `消费后将低于安全线 ${formatMoney(simulation.safetyGapCents)}` : "消费后不会跌破安全线"}</span></div><div className="simulation-grid"><div><span>本周剩余</span><strong>{formatMoney(simulation.afterWeeklyCents)}</strong></div><div><span>账户余额</span><strong>{formatMoney(simulation.afterBalanceCents)}</strong></div><div><span>分期覆盖</span><strong>{simulation.installmentCovered ? "可以覆盖" : "存在风险"}</strong></div></div></Card></div></div>;
}

function SalaryView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const plan = data.salaryPlans[0]; const expected = plan ? salaryExpectedPayments(plan, data.attendance) : [];
  const [confirmingPaid, setConfirmingPaid] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<string | null>(null);
  const latestSettlement = data.salarySettlements.filter((item) => item.planId === plan?.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  useEffect(() => {
    if (!plan) return;
    void ensureLegacySalarySettlements(plan, data.attendance, data.transactions, data.salarySettlements)
      .then(async (changed) => { if (changed) await onRefresh(); });
  }, [plan?.id]);
  if (!plan) return <Empty text="请先创建工资计划" />;
  const changeAttendance = async (id: string, status: Attendance["status"]) => {
    await setAttendanceStatus(plan, id, status);
    await onRefresh();
    setToast("考勤和工资已自动重算");
  };
  const confirmPaid = async () => {
    if (!m.salary.receivableCents) return;
    if (!confirmingPaid) { setConfirmingPaid(true); setToast("请再次点击，确认工资确实已到账"); return; }
    const settlement = await confirmSalarySettlement(
      plan,
      data.attendance,
      data.salarySettlements,
      data.accounts.find((account) => !account.hidden)?.id ?? data.accounts[0].id,
      data.categories.find((category) => category.id === "income-工资-暑假工工资")?.id,
      TODAY,
    );
    setConfirmingPaid(false);
    await onRefresh();
    setToast(settlement ? "工资已结算到账，后续考勤修改会自动联动" : "没有新的已出勤工资可结算");
  };
  const undoPayment = async () => {
    if (!latestSettlement) return;
    if (pendingUndo !== latestSettlement.id) { setPendingUndo(latestSettlement.id); setToast("请再次点击，确认撤销这笔工资到账"); return; }
    await db.transaction("rw", [db.transactions, db.salarySettlements], async () => {
      await db.transactions.delete(latestSettlement.transactionId);
      await db.salarySettlements.delete(latestSettlement.id);
    });
    await queueLocalChange("transactions", latestSettlement.transactionId, "delete");
    await queueLocalChange("salarySettlements", latestSettlement.id, "delete");
    setPendingUndo(null); await onRefresh(); setToast("已撤销工资到账，应收与余额已恢复");
  };
  return <div className="page-stack">
    <section className="salary-cards"><MetricCard icon={<BriefcaseBusiness />} label="累计已赚" value={formatMoney(m.salary.earnedCents)} sub="只计算确认出勤" tone="blue" /><MetricCard icon={<Bell />} label="尚未到账" value={formatMoney(m.salary.receivableCents)} sub="不计入可消费余额" tone="violet" /><MetricCard icon={<CalendarDays />} label="未来预计工资" value={formatMoney(m.salary.futureCents)} sub={`计划至 ${plan.endDate}`} tone="green" /></section>
    <div className="content-grid">
      <Card title="工资计划"><div className="plan-details"><div><span>工作</span><strong>{plan.employer}</strong></div><div><span>开始日期</span><strong>{plan.startDate}</strong></div><div><span>日薪</span><strong>{formatMoney(plan.dailyRateCents)}</strong></div><div><span>结算规则</span><strong>每月 {plan.cutoffDay} 日截止，{plan.payDay} 日发薪</strong></div></div><label className="end-date-control"><span>最后工作日（包含当天）</span><input type="date" min={plan.startDate} value={plan.endDate} onChange={async (event) => {
        try {
          await setSalaryEndDate(plan, event.target.value as LocalDate);
          await onRefresh();
          setToast("最后工作日已更新，后续工资已自动调整");
        } catch (reason) {
          setToast(reason instanceof Error ? reason.message : "日期修改失败");
        }
      }} /></label><button className={`primary full ${confirmingPaid ? "confirming" : ""}`} disabled={!m.salary.receivableCents} onClick={confirmPaid}><Check />{confirmingPaid ? "再次点击确认到账" : "确认应收工资已到账"}</button>{latestSettlement && <div className="salary-undo"><div><span>最近工资结算</span><strong>{latestSettlement.periodEnd} · {formatMoney(latestSettlement.amountCents)}</strong></div><button className={pendingUndo === latestSettlement.id ? "danger solid" : "danger"} onClick={undoPayment}><RotateCcw />{pendingUndo === latestSettlement.id ? "再次点击撤销" : "撤销到账"}</button></div>}</Card>
      <Card title="预计发薪批次"><div className="timeline">{expected.map((item) => <div key={item.date}><i /><div><strong>{item.date}</strong><span>预计到账</span></div><b>{formatMoney(item.amountCents)}</b></div>)}</div>{data.salaryAdjustments.length > 0 && <div className="salary-audit"><strong>最近自动调整</strong>{data.salaryAdjustments.slice(0, 3).map((item) => <span key={item.id}>{item.reason}：{formatMoney(item.previousAmountCents)} → {formatMoney(item.nextAmountCents)}</span>)}</div>}</Card>
    </div>
    <Card title="每日考勤"><p className="chart-note">可以随时修改任意一天。待确认、休息、请假和未在职均不计工资；修改已结算日期会同步调整到账流水和账户余额。</p><div className="attendance-grid editable">{data.attendance.filter((item) => item.planId === plan.id).map((item) => <div key={item.id} className={item.status}><span>{item.date.slice(5)}</span><strong>{attendanceStatusLabel(item.status)}</strong><small>{formatMoney(item.earnedCents)}</small><select aria-label={`${item.date}考勤状态`} value={item.status} disabled={item.date > plan.endDate} onChange={(event) => changeAttendance(item.id, event.target.value as Attendance["status"])}><option value="worked">出勤</option><option value="off">休息</option><option value="leave">请假</option><option value="pending">待确认</option>{item.date > plan.endDate && <option value="not_employed">未在职</option>}</select></div>)}</div></Card>
  </div>;
}

function InstallmentsView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const pay = async (id: string) => { const item = data.installmentItems.find((i) => i.id === id); if (!item) return; const transactionId = uid("installment"); await db.transaction("rw", [db.installmentItems, db.transactions], async () => { await db.installmentItems.update(id, { status: "paid", actualPaidDate: TODAY }); await db.transactions.add({ id: transactionId, type: "installment_payment", status: "posted", amountCents: item.amountCents, date: TODAY, time: new Date().toTimeString().slice(0, 5), accountId: data.installmentPlans[0].accountId, categoryId: data.installmentPlans[0].categoryId, merchant: data.installmentPlans[0].name, note: `第 ${item.sequence} 期付款`, countsTowardBudget: false, rigid: true, reimbursable: false, tags: ["分期"], attachmentIds: [], linkedId: item.id, affectsBalance: true, createdAt: new Date().toISOString() }); }); await queueLocalChange("installmentItems", id); await queueLocalChange("transactions", transactionId); await onRefresh(); setToast("本期已标记为还款"); };
  return <div className="page-stack"><section className="installment-hero"><div><p>PS课程分期</p><h2>{formatMoney(m.installments.remainingCents)}</h2><span>剩余 {m.installments.remainingCount} 期</span></div><div><span>下次还款</span><strong>{m.installments.next?.dueDate}</strong><b>{m.installments.next ? formatMoney(m.installments.next.amountCents) : "已结清"}</b></div></section><section className="pressure-grid"><div><span>未来30天</span><strong>{formatMoney(m.installments.pressure30Cents)}</strong></div><div><span>未来60天</span><strong>{formatMoney(m.installments.pressure60Cents)}</strong></div><div><span>未来90天</span><strong>{formatMoney(m.installments.pressure90Cents)}</strong></div></section><Card title="还款时间轴"><div className="installment-list">{data.installmentItems.map((item) => <div key={item.id} className={item.status}><div className="installment-no">{item.status === "paid" ? <Check /> : item.sequence}</div><div><strong>第 {item.sequence} 期</strong><span>{item.dueDate}{item.historicalSnapshot ? " · 余额快照前" : ""}</span></div><b>{formatMoney(item.amountCents)}</b><span className={`badge ${item.reserved ? "reserved" : ""}`}>{item.status === "paid" ? "已还" : item.reserved ? "已预留" : "待还"}</span>{item.status === "unpaid" && <button onClick={() => pay(item.id)}>还款</button>}</div>)}</div></Card></div>;
}

function CalendarView({ data, metrics: m }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics> }) {
  const [month, setMonth] = useState(TODAY.slice(0, 7));
  const [selected, setSelected] = useState<LocalDate>(TODAY);
  const bounds = monthBounds(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1, 12).getDay();
  const dayCount = Number(bounds.end.slice(-2));
  const days = Array.from({ length: dayCount }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}` as LocalDate);
  const moveMonth = (offset: number) => {
    const date = new Date(year, monthNumber - 1 + offset, 1, 12);
    const nextMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    setMonth(nextMonth);
    setSelected(`${nextMonth}-01` as LocalDate);
  };
  const eventsFor = (date: LocalDate) => {
    const recurring = data.recurringRules.filter((rule) => recurringOccurrences(rule, date, date).length > 0);
    return {
      income: m.expectedIncome.filter((item) => item.date === date).reduce((sum, item) => sum + item.amountCents, 0)
        + recurring.filter((rule) => rule.type === "income").reduce((sum, rule) => sum + rule.amountCents, 0),
      installment: data.installmentItems.filter((item) => item.dueDate === date && item.status === "unpaid").reduce((sum, item) => sum + item.amountCents, 0),
      recurringExpense: recurring.filter((rule) => rule.type === "expense").reduce((sum, rule) => sum + rule.amountCents, 0),
      recurring,
      transactions: data.transactions.filter((transaction) => transaction.date === date),
    };
  };
  const selectedEvents = eventsFor(selected);
  const forecast = forecastCashflow({ targetDate: selected, asOf: TODAY, currentBalanceCents: m.balance, expectedIncome: m.expectedIncome, installments: data.installmentItems, plannedTransactions: data.transactions, recurringRules: data.recurringRules, includeExpectedIncome: true });
  return <div className="calendar-layout"><section className="card"><div className="calendar-title"><button aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft /></button><h2>{year} 年 {monthNumber} 月</h2><button aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight /></button></div><div className="calendar-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div className="calendar-grid">{Array.from({ length: firstDay }).map((_, index) => <i key={`blank-${index}`} />)}{days.map((date) => { const events = eventsFor(date); const expense = events.installment + events.recurringExpense; return <button className={`${selected === date ? "selected" : ""} ${date === TODAY ? "today" : ""}`} key={date} onClick={() => setSelected(date)}><strong>{Number(date.slice(-2))}</strong><span>{events.income > 0 && <i className="event-in" />}{expense > 0 && <i className="event-out" />}</span><small>{events.income ? `+${Math.round(events.income / 100)}` : expense ? `-${Math.round(expense / 100)}` : ""}</small></button>; })}</div></section><aside className="day-panel"><p>{selected}</p><h2>{selected >= TODAY ? "预计余额" : "当前账本余额"}</h2><strong>{formatMoney(forecast.balanceCents)}</strong><div><span>预计到账</span><b className="positive">+{formatMoney(selectedEvents.income)}</b></div><div><span>分期到期</span><b className="negative">−{formatMoney(selectedEvents.installment)}</b></div><div><span>周期支出</span><b className="negative">−{formatMoney(selectedEvents.recurringExpense)}</b></div><div><span>预计自由资金</span><b>{formatMoney(Math.max(0, forecast.balanceCents - m.safety.totalCents))}</b></div>{selectedEvents.recurring.map((rule) => <small key={rule.id} className="calendar-event-label">{rule.name} · {formatMoney(rule.amountCents)}</small>)}<Insight icon={<CalendarDays />} text="日历会随当前月份自动推进；计划项目只影响预测，确认执行后才修改真实余额。" /></aside></div>;
}

function AnalyticsView({ data, setToast }: { data: LedgerSnapshot; setToast: (message: string) => void }) {
  const [monthPrefix, setMonthPrefix] = useState(TODAY.slice(0, 7));
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AiAnalysisResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const bounds = monthBounds(monthPrefix);
  const selectedMonthDate = new Date(Number(monthPrefix.slice(0, 4)), Number(monthPrefix.slice(5)) - 2, 1, 12);
  const previousMonth = `${selectedMonthDate.getFullYear()}-${String(selectedMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const summary = monthlyFinanceSummary(data.transactions, monthPrefix);
  const previousSummary = monthlyFinanceSummary(data.transactions, previousMonth);
  const categoryTrend = monthlyCategorySpendingTrend(data.transactions, data.categories, bounds.end);
  const categoryLines = categoryTrend.days.map(({ date, amounts }) => ({ date, ...Object.fromEntries(Object.entries(amounts).map(([id, cents]) => [id, cents / 100])) }));
  const pie = categoryTrend.series.map((series) => ({ name: series.name, value: series.totalCents / 100 }));
  const trend = Array.from({ length: Math.ceil(categoryTrend.days.length / 7) }, (_, index) => ({ name: `第${index + 1}周`, 支出: 0 }));
  categoryTrend.days.forEach((day, index) => { trend[Math.floor(index / 7)].支出 += Object.values(day.amounts).reduce((sum, cents) => sum + cents, 0) / 100; });
  const dailyTrend = dailyConsumptionTrend(data.transactions, bounds.end, Number(bounds.end.slice(-2))).map((item) => ({ date: item.date, 消费: item.amountCents / 100 }));
  const elapsedDays = monthPrefix === TODAY.slice(0, 7) ? Math.max(1, Number(TODAY.slice(-2))) : Number(bounds.end.slice(-2));
  const expenseChange = summary.expenseCents - previousSummary.expenseCents;
  useEffect(() => {
    void db.settings.get(`monthClose:${monthPrefix}`).then((setting) => {
      const value = setting?.value as { closedAt?: string } | undefined;
      setClosedAt(value?.closedAt ?? null);
    });
    setAiError("");
    setAiResult(null);
    void db.settings.get(`aiAnalysis:${monthPrefix}`).then((setting) => {
      if (isAiAnalysisResponse(setting?.value)) setAiResult(setting.value);
    });
  }, [monthPrefix]);
  const closeMonth = async () => {
    const closedAtValue = new Date().toISOString();
    await db.settings.put({ key: `monthClose:${monthPrefix}`, value: { ...summary, closedAt: closedAtValue } });
    await queueLocalChange("settings", `monthClose:${monthPrefix}`);
    setClosedAt(closedAtValue);
    setToast(`${monthPrefix} 月度结账快照已保存`);
  };
  const runAiAnalysis = async () => {
    setAiLoading(true);
    setAiError("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(cloudApiUrl("/api/ai/analyze"), {
        method: "POST",
        credentials: cloudCredentials(),
        headers: cloudHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ snapshot: buildAiAnalysisInput(data, monthPrefix, TODAY) }),
        signal: controller.signal,
      });
      const value = await parseAiAnalysisHttpResponse(response);
      await db.settings.put({ key: `aiAnalysis:${monthPrefix}`, value });
      await queueLocalChange("settings", `aiAnalysis:${monthPrefix}`);
      setAiResult(value);
      setToast("AI 财务分析已生成");
    } catch (reason) {
      const message = reason instanceof DOMException && reason.name === "AbortError"
        ? "AI 分析超时，请稍后重试"
        : reason instanceof Error ? reason.message : "AI 分析暂时不可用";
      setAiError(message);
    } finally {
      window.clearTimeout(timer);
      setAiLoading(false);
    }
  };
  const riskLabel = { low: "风险较低", medium: "需要关注", high: "风险较高" } as const;
  const priorityLabel = { low: "可优化", medium: "建议处理", high: "优先处理" } as const;
  return <div className="page-stack">
    <div className="analytics-period"><div><strong>月度财务报告</strong><span>{closedAt ? `已结账：${new Date(closedAt).toLocaleString("zh-CN")}` : "收入、支出、储蓄率和分类变化"}</span></div><div className="analytics-period-actions"><input type="month" value={monthPrefix} max={TODAY.slice(0, 7)} onChange={(event) => setMonthPrefix(event.target.value)} /><button disabled={!monthPrefix} onClick={() => downloadText(`青蓝流水-${monthPrefix}.csv`, exportMonthlyTransactionsCsv(data.transactions, data.accounts, data.categories, monthPrefix), "text/csv;charset=utf-8")}><Download />导出本月流水</button><button onClick={closeMonth}><Check />{closedAt ? "更新结账" : "保存结账"}</button></div></div>
    <section className="analytics-metrics"><div><span>本月收入</span><strong className="positive">{formatMoney(summary.incomeCents)}</strong></div><div><span>本月支出</span><strong className="negative">{formatMoney(summary.expenseCents)}</strong></div><div><span>净结余</span><strong>{formatMoney(summary.netCents)}</strong></div><div><span>储蓄率</span><strong>{summary.savingsRate}%</strong></div></section>
    <section className="monthly-insights"><div><span>日均消费</span><strong>{formatMoney(Math.round(summary.expenseCents / elapsedDays))}</strong></div><div><span>刚性支出占比</span><strong>{summary.expenseCents ? Math.round(summary.rigidCents / summary.expenseCents * 100) : 0}%</strong></div><div><span>较上月支出</span><strong className={expenseChange > 0 ? "negative" : "positive"}>{expenseChange > 0 ? "+" : ""}{formatMoney(expenseChange)}</strong></div></section>
    <section className="ai-analysis-card">
      <div className="ai-analysis-head"><div className="ai-analysis-title"><span><Sparkles /></span><div><strong>AI 财务分析</strong><small>分析现金安全、预算、工资、分期与储蓄目标</small></div></div><button onClick={() => void runAiAnalysis()} disabled={aiLoading}>{aiLoading ? <RefreshCw className="sync-spin" /> : <Sparkles />}{aiLoading ? "正在分析" : aiResult ? "重新分析" : "生成分析"}</button></div>
      <p className="ai-privacy"><ShieldCheck />仅发送金额汇总、类别和日期；不会发送商户、备注、附件或账号邮箱。</p>
      {aiLoading && <div className="ai-loading" role="status"><span /><span /><span /><p>AI 正在核对本月现金流和风险，请稍候…</p></div>}
      {aiError && <div className="ai-error"><ShieldAlert /><div><strong>暂时无法生成分析</strong><span>{aiError}</span></div></div>}
      {!aiLoading && !aiError && !aiResult && <div className="ai-empty"><Sparkles /><strong>让 AI 帮你读懂这个月</strong><span>它会基于账本中的真实汇总数字给出风险提示和下一步行动。</span></div>}
      {!aiLoading && aiResult && <div className="ai-result">
        <div className="ai-score"><div style={{ "--ai-score": `${aiResult.analysis.healthScore}%` } as React.CSSProperties}><strong>{aiResult.analysis.healthScore}</strong><span>财务健康分</span></div><section><i className={aiResult.analysis.riskLevel}>{riskLabel[aiResult.analysis.riskLevel]}</i><h3>{aiResult.analysis.headline}</h3><p>{aiResult.analysis.overview}</p></section></div>
        <div className="ai-insight-grid">{aiResult.analysis.insights.map((insight, index) => <article key={`${insight.title}-${index}`} className={insight.priority}><header><span>{priorityLabel[insight.priority]}</span><strong>{insight.title}</strong></header><p>{insight.finding}</p><small>{insight.evidence}</small><b>{insight.action}</b></article>)}</div>
        <div className="ai-next-actions"><strong>接下来优先做</strong><ol>{aiResult.analysis.nextActions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}</ol></div>
        <footer><span>生成于 {new Date(aiResult.generatedAt).toLocaleString("zh-CN")} · {aiResult.model}</span><span>AI 结果仅供个人财务管理参考，请以账本真实数据和实际情况为准。</span></footer>
      </div>}
    </section>
    <Card title={`${monthPrefix.replace("-", " 年 ")} 月 · 每日消费`}><div className="chart daily-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={dailyTrend} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5).replace("-", "/")} minTickGap={24} /><YAxis tickFormatter={(value) => `¥${value}`} width={52} /><Tooltip labelFormatter={(label) => String(label)} formatter={(value) => [`¥${Number(value).toFixed(2)}`, "消费"]} /><Line type="monotone" dataKey="消费" stroke="#20b8c4" strokeWidth={3} dot={false} activeDot={{ r: 5, fill: "#3b82f6", stroke: "#dffcff", strokeWidth: 2 }} /></LineChart></ResponsiveContainer></div></Card>
    <Card title={`${categoryTrend.month.replace("-", " 年 ")} 月 · 分类每日支出`}>{categoryTrend.series.length ? <><div className="category-line-legend">{categoryTrend.series.map((series, index) => <div key={series.id}><i style={{ background: palette[index % palette.length] }} /><span>{series.name}</span><strong>{formatMoney(series.totalCents)}</strong></div>)}</div><div className="chart category-line-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={categoryLines} margin={{ top: 10, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(-2)} minTickGap={22} /><YAxis tickFormatter={(value) => `¥${value}`} width={52} /><Tooltip labelFormatter={(label) => `${String(label).slice(5).replace("-", "月")}日`} formatter={(value, name) => [`¥${Number(value).toFixed(2)}`, categoryTrend.series.find((series) => series.id === name)?.name ?? name]} />{categoryTrend.series.map((series, index) => <Line key={series.id} type="linear" dataKey={series.id} name={series.id} stroke={palette[index % palette.length]} strokeWidth={2.4} dot={false} activeDot={{ r: 4 }} />)}</LineChart></ResponsiveContainer></div></> : <Empty text="该月记录支出后会显示分类折线" />}</Card>
    <div className="content-grid"><Card title="每周消费趋势"><div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><defs><linearGradient id="trend" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#22a6b3" stopOpacity={0.5}/><stop offset="100%" stopColor="#22a6b3" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis /><Tooltip formatter={(value) => [`¥${Number(value).toFixed(2)}`, "支出"]} /><Area dataKey="支出" stroke="#138697" fill="url(#trend)" /></AreaChart></ResponsiveContainer></div></Card><Card title="分类支出占比">{pie.length ? <div className="chart pie"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85}>{pie.map((_, index) => <Cell key={index} fill={palette[index % palette.length]} />)}</Pie><Tooltip formatter={(value) => `¥${Number(value).toFixed(2)}`} /></PieChart></ResponsiveContainer></div> : <Empty text="该月还没有支出" />}</Card></div>
  </div>;
}

function AccountsView({ data, metrics: m, onRefresh, setToast }: { data: LedgerSnapshot; metrics: ReturnType<typeof deriveMetrics>; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const [name, setName] = useState(""); const [balance, setBalance] = useState("");
  const add = async () => { if (!name.trim()) return; const id = uid("acc"); await db.accounts.add({ id, name: name.trim(), icon: "WalletCards", openingBalanceCents: asCents(Number(balance) || 0), balanceAsOf: TODAY, hidden: false, sort: data.accounts.length + 1 }); await queueLocalChange("accounts", id); setName(""); setBalance(""); await onRefresh(); setToast("账户已添加"); };
  const reconcile = async (id: string, current: Cents) => {
    const value = window.prompt("输入微信、支付宝或银行卡显示的真实余额（元）", String(current / 100));
    if (value === null) return;
    const actualBalanceCents = asCents(Number(value));
    if (!Number.isFinite(actualBalanceCents)) { setToast("金额格式无效"); return; }
    const differenceCents = actualBalanceCents - current;
    const snapshotId = uid("reconciliation");
    const transactionId = differenceCents === 0 ? undefined : uid("adjustment");
    await db.transaction("rw", [db.reconciliations, db.transactions], async () => {
      await db.reconciliations.add({
        id: snapshotId,
        accountId: id,
        date: TODAY,
        bookBalanceCents: current,
        actualBalanceCents,
        differenceCents,
        adjustmentTransactionId: transactionId,
        createdAt: new Date().toISOString(),
      });
      if (transactionId) await db.transactions.add({
        id: transactionId,
        type: "adjustment",
        status: "posted",
        amountCents: Math.abs(differenceCents),
        date: TODAY,
        time: new Date().toTimeString().slice(0, 5),
        accountId: id,
        note: "账户对账差额调整",
        countsTowardBudget: false,
        rigid: false,
        reimbursable: false,
        tags: ["对账"],
        attachmentIds: [],
        adjustmentDirection: differenceCents >= 0 ? "in" : "out",
        affectsBalance: true,
        createdAt: new Date().toISOString(),
      });
    });
    await queueLocalChange("reconciliations", snapshotId);
    if (transactionId) await queueLocalChange("transactions", transactionId);
    await onRefresh();
    setToast(differenceCents === 0 ? "对账一致，已保存快照" : `已生成差额调整 ${formatMoney(differenceCents)}`);
  };
  return <div className="page-stack"><section className="account-total"><span>全部账户余额</span><strong>{formatMoney(m.balance)}</strong><small>{data.accounts.filter((account) => !account.hidden).length} 个可见账户</small></section><div className="account-grid">{data.accounts.map((account) => <article key={account.id}><div className="account-icon"><WalletCards /></div><div><span>{account.name}</span><strong>{formatMoney(m.balances[account.id] ?? 0)}</strong><small>余额基准日 {account.balanceAsOf}</small></div><div className="account-actions"><button onClick={() => reconcile(account.id, m.balances[account.id] ?? 0)}>对账</button><button onClick={async () => { await db.accounts.update(account.id, { hidden: !account.hidden }); await queueLocalChange("accounts", account.id); await onRefresh(); }}>{account.hidden ? "显示" : "隐藏"}</button></div></article>)}</div>{data.reconciliations.length > 0 && <Card title="最近对账记录"><div className="reconciliation-list">{data.reconciliations.slice(0, 6).map((item) => <div key={item.id}><span><strong>{data.accounts.find((account) => account.id === item.accountId)?.name}</strong><small>{item.date} · 账本 {formatMoney(item.bookBalanceCents)} / 实际 {formatMoney(item.actualBalanceCents)}</small></span><b className={item.differenceCents === 0 ? "positive" : "negative"}>{item.differenceCents === 0 ? "一致" : formatMoney(item.differenceCents)}</b></div>)}</div></Card>}<Card title="新增账户"><div className="inline-form"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="账户名称" /><input inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder="当前余额" /><button className="primary" onClick={add}><Plus />添加账户</button></div></Card></div>;
}

function SettingsView({ data, theme, setTheme, onRefresh, setToast }: { data: LedgerSnapshot; theme: string; setTheme: (t: "light" | "dark") => void; onRefresh: () => Promise<void>; setToast: (s: string) => void }) {
  const cloud = useCloudSync();
  const [clearText, setClearText] = useState(""); const [importInfo, setImportInfo] = useState<{ text: string; accounts: number; transactions: number } | null>(null); const [githubCode, setGithubCode] = useState(() => getExternalSyncCode());
  const [generatingCode, setGeneratingCode] = useState(false);
  const [exportMonth, setExportMonth] = useState(TODAY.slice(0, 7));
  const monthlyTransactionCount = data.transactions.filter((t) => t.date.slice(0, 7) === exportMonth).length;
  const [csvInfo, setCsvInfo] = useState<{ fileName: string; preview: ReturnType<typeof previewTransactionCsv> } | null>(null);
  const exportJson = async () => downloadText(`青蓝账本-${TODAY}.json`, await exportBackup(), "application/json");
  const previewImport = async (file?: File) => { if (!file) return; const text = await file.text(); try { const value = JSON.parse(text); if (![1, 2].includes(value.schemaVersion) || !Array.isArray(value.accounts) || !Array.isArray(value.transactions)) throw new Error(); setImportInfo({ text, accounts: value.accounts.length, transactions: value.transactions.length }); } catch { setToast("备份文件格式无效"); } };
  const runImport = async (mode: "merge" | "replace") => { if (!importInfo) return; await importBackup(importInfo.text, mode); setImportInfo(null); await onRefresh(); setToast(mode === "merge" ? "备份已合并" : "备份已恢复"); };
  const previewCsv = async (file?: File) => {
    if (!file) return;
    const bytes = await file.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.includes("�")) {
      try { text = new TextDecoder("gb18030").decode(bytes); } catch { /* 使用 UTF-8 结果 */ }
    }
    try {
      setCsvInfo({ fileName: file.name, preview: previewTransactionCsv(text, file.name, data.transactions) });
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "CSV账单无法识别");
    }
  };
  const runCsvImport = async () => {
    if (!csvInfo?.preview.rows.length) return;
    const batchId = uid("import");
    const accountName = { wechat: "微信", alipay: "支付宝", bank: "银行卡", generic: "" }[csvInfo.preview.source];
    const account = data.accounts.find((item) => item.name.includes(accountName) && !item.hidden) ?? data.accounts.find((item) => !item.hidden);
    if (!account) { setToast("请先创建可用账户"); return; }
    const transactionIds: string[] = [];
    const now = new Date().toISOString();
    await db.transaction("rw", [db.transactions, db.importBatches], async () => {
      for (const row of csvInfo.preview.rows) {
        const categoryKind = row.type === "expense" ? "expense" : "income";
        const category = data.categories.find((item) => item.kind === categoryKind && item.parentId && !item.archived);
        const id = uid("tx");
        transactionIds.push(id);
        await db.transactions.add({
          id,
          type: row.type,
          status: "posted",
          amountCents: row.amountCents,
          date: row.date,
          time: row.time,
          accountId: account.id,
          categoryId: category?.id,
          merchant: row.merchant,
          note: row.note,
          countsTowardBudget: row.type === "expense",
          rigid: false,
          reimbursable: false,
          tags: ["账单导入", ...(row.orderId ? [`import-order:${row.orderId}`] : [])],
          attachmentIds: [],
          importBatchId: batchId,
          affectsBalance: true,
          createdAt: now,
        });
      }
      await db.importBatches.add({
        id: batchId,
        source: csvInfo.preview.source,
        fileName: csvInfo.fileName,
        importedAt: now,
        recordCount: transactionIds.length,
        duplicateCount: csvInfo.preview.duplicateCount,
        transactionIds,
        status: "imported",
      });
    });
    for (const id of transactionIds) await queueLocalChange("transactions", id);
    await queueLocalChange("importBatches", batchId);
    setCsvInfo(null);
    await onRefresh();
    setToast(`成功导入 ${transactionIds.length} 条，跳过 ${csvInfo.preview.duplicateCount} 条重复`);
  };
  const rollbackBatch = async (batchId: string) => {
    const batch = data.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "imported") return;
    await db.transaction("rw", [db.transactions, db.importBatches], async () => {
      await db.transactions.bulkDelete(batch.transactionIds);
      await db.importBatches.update(batch.id, { status: "reverted" });
    });
    for (const id of batch.transactionIds) await queueLocalChange("transactions", id, "delete");
    await queueLocalChange("importBatches", batch.id);
    await onRefresh();
    setToast("该批账单已整批撤销");
  };
  const queueBudget = async () => { await queueLocalChange("budgets", "main"); await onRefresh(); };
  const lastSync = cloud.state.lastSyncedAt ? new Date(cloud.state.lastSyncedAt).toLocaleString("zh-CN") : "尚未完成";
  const generateGitHubCode = async () => { setGeneratingCode(true); try { const code = await cloud.createGitHubSyncCode(); setGithubCode(code); setToast("同步码已生成，请复制保存"); } catch (reason) { setToast(reason instanceof Error ? reason.message : "生成同步码失败"); } finally { setGeneratingCode(false); } };
  const copyGitHubCode = async () => { try { await navigator.clipboard.writeText(githubCode); setToast("同步码已复制"); } catch { setToast("请长按或选中同步码，手动复制"); } };
  return <div className="settings-grid">
    <section className="settings-section wide cloud-account-section">
      <h2>账号与云同步</h2>
      {cloud.configured && cloud.user ? <div className="cloud-account"><div className="cloud-profile">{cloud.user.photoURL ? <img src={cloud.user.photoURL} alt="账号头像" /> : <div className="profile-fallback">青</div>}<div><strong>{cloud.externalMode ? "GitHub Pages 同步账本" : cloud.user.displayName || "统一账号用户"}</strong><span>{cloud.externalMode ? "已通过同步码连接" : cloud.user.email}</span><small>最后同步：{lastSync}</small></div></div><div className="cloud-controls"><SyncStatusGlyph /><button onClick={() => void cloud.syncNow()}><RefreshCw />立即同步</button><button className="danger" onClick={() => void cloud.logout()}>{cloud.externalMode ? "断开本机" : "退出登录"}</button></div></div> : <div className="cloud-needed"><ShieldCheck /><div><strong>{cloud.configured ? "正在连接统一账号" : "当前为本地安全模式"}</strong><p>{cloud.configured ? "连接完成后会自动迁移本机旧账，并开始手机、电脑之间的增量同步。" : "云数据库暂时不可用；账目仍完整保存在 IndexedDB，恢复后会自动补传。"}</p></div></div>}
      {!cloud.externalMode && cloud.user && <div className="github-sync-code">
        <div><strong>GitHub Pages 同步码</strong><p>用于连接现有云端账本，不会创建新账本或清空旧数据。它相当于账本密码，请勿分享。</p></div>
        <button disabled={generatingCode || !cloud.online} onClick={() => void generateGitHubCode()}>{generatingCode ? "正在生成…" : githubCode ? "生成另一同步码" : "生成 48 位同步码"}</button>
        {githubCode && <><code>{githubCode}</code><button onClick={() => void copyGitHubCode()}>复制同步码</button></>}
      </div>}
    </section>
    <section className="settings-section"><h2>预算与安全线</h2><SettingRow label="安全线范围" hint="决定哪些近期分期计入锁定资金"><select value={data.budget.safetyMode} onChange={async (e) => { await db.budgets.update("main", { safetyMode: e.target.value as typeof data.budget.safetyMode }); await queueBudget(); }}><option value="30d">未来30天</option><option value="60d">未来60天</option><option value="school">计算到开学</option><option value="custom">自定义金额</option></select></SettingRow><SettingRow label="每周结余" hint="决定结余是否滚入下周"><select value={data.budget.rolloverMode} onChange={async (e) => { await db.budgets.update("main", { rolloverMode: e.target.value as "rollover" | "reset" }); await queueBudget(); }}><option value="reset">每周清零</option><option value="rollover">结余滚存</option></select></SettingRow><SettingRow label="开学日期" hint="用于安全线和未来预测"><input type="date" value={data.budget.schoolDate} onChange={async (e) => { await db.budgets.update("main", { schoolDate: e.target.value as LocalDate }); await queueBudget(); }} /></SettingRow></section>
    <section className="settings-section"><h2>显示与隐私</h2><SettingRow label="界面主题" hint="登录后会同步到所有设备"><div className="theme-toggle"><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}><Sun />浅色</button><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}><Moon />深色</button></div></SettingRow><SettingRow label="本地缓存" hint="离线时仍可读写，联网后自动补传"><span className="local-badge"><ShieldCheck />IndexedDB 已启用</span></SettingRow></section>
    <DataSecurityCenter />
    <section className="settings-section wide"><h2>按月导出流水</h2>
      <p>选择一个月份，导出 CSV 后可以直接发给我分析花销。保留收入、支出、退款、转账及撤销状态，不包含图片附件或同步码。</p>
      <div className="inline-form">
        <label>导出月份 <input aria-label="导出流水月份" type="month" value={exportMonth} onChange={(event) => setExportMonth(event.target.value)} /></label>
        <span>{monthlyTransactionCount} 条流水</span>
        <button disabled={!exportMonth || !monthlyTransactionCount} onClick={() => { downloadText(`青蓝流水-${exportMonth}.csv`, exportMonthlyTransactionsCsv(data.transactions, data.accounts, data.categories, exportMonth), "text/csv;charset=utf-8"); setToast(`已导出 ${exportMonth} 的 ${monthlyTransactionCount} 条流水`); }}><Download />导出所选月份 CSV</button>
      </div>
      {!monthlyTransactionCount && <p>该月暂无流水，可选择其他月份。</p>}
    </section>
    <section className="settings-section wide"><h2>备份、恢复与账单导入</h2><div className="backup-actions"><button onClick={exportJson}><Download />导出完整 JSON</button><button onClick={() => downloadText(`青蓝流水-${TODAY}.csv`, exportTransactionsCsv(data.transactions, data.accounts, data.categories), "text/csv;charset=utf-8")}><Download />导出流水 CSV</button><label className="button-label"><FileUp />导入 JSON<input type="file" accept="application/json" onChange={(event) => previewImport(event.target.files?.[0])} /></label><label className="button-label"><FileUp />导入微信/支付宝/银行卡 CSV<input type="file" accept=".csv,text/csv" onChange={(event) => previewCsv(event.target.files?.[0])} /></label></div>{importInfo && <div className="import-preview"><div><strong>备份导入预览</strong><span>{importInfo.accounts} 个账户 · {importInfo.transactions} 条流水</span><p>合并会按 ID 更新同名记录；覆盖会先清除当前账本。导入后的变化会进入增量同步队列。</p></div><button onClick={() => runImport("merge")}>合并导入</button><button className="danger" onClick={() => runImport("replace")}>覆盖恢复</button></div>}{csvInfo && <div className="import-preview"><div><strong>{csvInfo.preview.sourceLabel}预览</strong><span>可导入 {csvInfo.preview.rows.length} 条 · 重复 {csvInfo.preview.duplicateCount} 条 · 无效 {csvInfo.preview.skippedCount} 条</span><p>默认导入对应账户；导入后可逐条编辑，也可整批撤销。</p></div><button onClick={runCsvImport}>确认导入</button><button onClick={() => setCsvInfo(null)}>取消</button></div>}{data.importBatches.length > 0 && <div className="import-history">{data.importBatches.slice(0, 5).map((batch) => <div key={batch.id}><span><strong>{batch.fileName}</strong><small>{new Date(batch.importedAt).toLocaleString("zh-CN")} · {batch.recordCount} 条</small></span><b>{batch.status === "imported" ? "已导入" : "已撤销"}</b>{batch.status === "imported" && <button className="danger" onClick={() => rollbackBatch(batch.id)}>整批撤销</button>}</div>)}</div>}</section>
    <section className="settings-section wide danger-zone"><h2>危险操作</h2><p>输入“清空数据”后可恢复首次示例数据。登录状态下，删除与恢复结果也会同步到其他设备。</p><div className="inline-form"><input value={clearText} onChange={(e) => setClearText(e.target.value)} placeholder="输入：清空数据" /><button className="danger solid" disabled={clearText !== "清空数据"} onClick={async () => { await resetDatabase(); setClearText(""); await onRefresh(); setToast("已恢复示例数据并加入同步队列"); }}><RotateCcw />清空并恢复示例</button></div></section>
  </div>;
}
function DataSecurityCenter() {
  const cloud = useCloudSync();
  const [overview, setOverview] = useState<{ devices: Array<{ deviceId: string; userAgent: string | null; lastSeenAt: string }>; conflicts: Array<{ entityType: string; recordId: string; reason: string; archivedAt: string }> } | null>(null);
  useEffect(() => {
    if (!cloud.user || !cloud.online) return;
    let active = true;
    void fetch(cloudApiUrl("/api/sync/security"), { credentials: cloudCredentials(), cache: "no-store", headers: cloudHeaders() })
      .then(async (response) => response.ok ? response.json() : null)
      .then((value) => { if (active && value) setOverview(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [cloud.user?.ownerId, cloud.online, cloud.state.lastSyncedAt]);
  return <section className="settings-section wide"><h2>数据安全中心</h2><div className="security-grid"><div><span>当前设备</span><strong>{getDeviceId().slice(0, 12)}…</strong><small>云端近期识别 {overview?.devices.length ?? 1} 台设备</small></div><div><span>待同步记录</span><strong>{cloud.state.pendingCount}</strong><small>{cloud.online ? "联网后自动增量上传" : "当前离线，本机数据不会丢失"}</small></div><div><span>同步状态</span><strong>{cloud.state.status === "success" ? "正常" : cloud.state.status === "syncing" ? "同步中" : cloud.state.status === "offline" ? "离线" : "需要检查"}</strong><small>{cloud.state.error ?? `历史冲突 ${overview?.conflicts.length ?? 0} 条`}</small></div><div><span>独立备份</span><strong>建议每月导出</strong><small>云同步不能替代可下载的完整 JSON</small></div></div>{overview && <div className="security-details"><div><strong>最近设备</strong>{overview.devices.slice(0, 4).map((device) => <span key={device.deviceId}>{device.userAgent?.includes("Mobile") ? "移动设备" : "电脑/平板"} · {new Date(device.lastSeenAt).toLocaleString("zh-CN")}</span>)}</div><div><strong>同步冲突历史</strong>{overview.conflicts.length ? overview.conflicts.slice(0, 4).map((item) => <span key={`${item.entityType}-${item.recordId}-${item.archivedAt}`}>{item.entityType} · {item.reason} · {new Date(item.archivedAt).toLocaleString("zh-CN")}</span>) : <span>暂无冲突记录</span>}</div></div>}</section>;
}
function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong><span>{hint}</span></div>{children}</div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><ReceiptText /><p>{text}</p></div>; }
