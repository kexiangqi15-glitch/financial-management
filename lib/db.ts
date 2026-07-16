import Dexie, { type EntityTable } from "dexie";
import type { Account, AppSetting, AttachmentRecord, Attendance, BudgetSettings, Category, InstallmentItem, InstallmentPlan, LedgerSnapshot, LedgerTransaction, Reserve, SalaryPlan } from "./types";
import * as seed from "./seed";

class QinglanDB extends Dexie {
  accounts!: EntityTable<Account, "id">;
  categories!: EntityTable<Category, "id">;
  transactions!: EntityTable<LedgerTransaction, "id">;
  salaryPlans!: EntityTable<SalaryPlan, "id">;
  attendance!: EntityTable<Attendance, "id">;
  installmentPlans!: EntityTable<InstallmentPlan, "id">;
  installmentItems!: EntityTable<InstallmentItem, "id">;
  reserves!: EntityTable<Reserve, "id">;
  budgets!: EntityTable<BudgetSettings, "id">;
  settings!: EntityTable<AppSetting, "key">;
  attachments!: EntityTable<AttachmentRecord, "id">;

  constructor() {
    super("qinglan-ledger");
    this.version(1).stores({
      accounts: "id, name, sort", categories: "id, kind, parentId, sort", transactions: "id, type, status, date, accountId, categoryId",
      salaryPlans: "id, active", attendance: "id, planId, date, [planId+date]", installmentPlans: "id", installmentItems: "id, planId, dueDate, status",
      reserves: "id, kind", budgets: "id", settings: "key", attachments: "id",
    });
  }
}
export const db = new QinglanDB();

export async function initializeDatabase() {
  const initialized = await db.settings.get("initialized");
  if (initialized) return;
  await db.transaction("rw", [db.accounts, db.categories, db.transactions, db.salaryPlans, db.attendance, db.installmentPlans, db.installmentItems, db.reserves, db.budgets, db.settings], async () => {
    await db.accounts.bulkPut(seed.accounts); await db.categories.bulkPut(seed.categories); await db.transactions.bulkPut(seed.transactions);
    await db.salaryPlans.bulkPut(seed.salaryPlans); await db.attendance.bulkPut(seed.attendance); await db.installmentPlans.bulkPut(seed.installmentPlans);
    await db.installmentItems.bulkPut(seed.installmentItems); await db.reserves.bulkPut(seed.reserves); await db.budgets.put(seed.budget);
    await db.settings.put({ key: "initialized", value: { schemaVersion: 1, at: new Date().toISOString() } });
  });
}

export async function loadSnapshot(): Promise<LedgerSnapshot> {
  const [accounts, categories, transactions, salaryPlans, attendance, installmentPlans, installmentItems, reserves, budget] = await Promise.all([
    db.accounts.orderBy("sort").toArray(), db.categories.orderBy("sort").toArray(), db.transactions.orderBy("date").reverse().toArray(),
    db.salaryPlans.toArray(), db.attendance.orderBy("date").toArray(), db.installmentPlans.toArray(), db.installmentItems.orderBy("dueDate").toArray(),
    db.reserves.toArray(), db.budgets.get("main"),
  ]);
  if (!budget) throw new Error("预算设置缺失，请在设置中恢复示例数据");
  return { accounts, categories, transactions, salaryPlans, attendance, installmentPlans, installmentItems, reserves, budget };
}

export async function resetDatabase() {
  await Promise.all([db.accounts.clear(), db.categories.clear(), db.transactions.clear(), db.salaryPlans.clear(), db.attendance.clear(), db.installmentPlans.clear(), db.installmentItems.clear(), db.reserves.clear(), db.budgets.clear(), db.settings.clear(), db.attachments.clear()]);
  await initializeDatabase();
}

export async function exportBackup() {
  const snapshot = await loadSnapshot();
  const attachments = await db.attachments.toArray();
  const encoded = await Promise.all(attachments.map(async (a) => ({ ...a, blob: await blobToDataUrl(a.blob) })));
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), ...snapshot, attachments: encoded }, null, 2);
}

export async function importBackup(json: string, mode: "merge" | "replace") {
  const value = JSON.parse(json) as Partial<LedgerSnapshot> & { schemaVersion?: number; attachments?: Array<Omit<AttachmentRecord, "blob"> & { blob: string }> };
  if (value.schemaVersion !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.transactions)) throw new Error("不是有效的青蓝账本 v1 备份");
  await db.transaction("rw", [db.accounts, db.categories, db.transactions, db.salaryPlans, db.attendance, db.installmentPlans, db.installmentItems, db.reserves, db.budgets, db.attachments], async () => {
    if (mode === "replace") await Promise.all([db.accounts.clear(), db.categories.clear(), db.transactions.clear(), db.salaryPlans.clear(), db.attendance.clear(), db.installmentPlans.clear(), db.installmentItems.clear(), db.reserves.clear(), db.budgets.clear(), db.attachments.clear()]);
    await db.accounts.bulkPut(value.accounts ?? []); await db.categories.bulkPut(value.categories ?? []); await db.transactions.bulkPut(value.transactions ?? []);
    await db.salaryPlans.bulkPut(value.salaryPlans ?? []); await db.attendance.bulkPut(value.attendance ?? []); await db.installmentPlans.bulkPut(value.installmentPlans ?? []);
    await db.installmentItems.bulkPut(value.installmentItems ?? []); await db.reserves.bulkPut(value.reserves ?? []); if (value.budget) await db.budgets.put(value.budget);
    if (value.attachments?.length) await db.attachments.bulkPut(value.attachments.map((a) => ({ ...a, blob: dataUrlToBlob(a.blob) })));
  });
  return { accounts: value.accounts.length, transactions: value.transactions.length };
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
export function exportTransactionsCsv(transactions: LedgerTransaction[], accounts: Account[], categories: Category[]) {
  const rows = transactions.map((t) => [t.date, t.time, t.type, t.status, (t.amountCents / 100).toFixed(2), accounts.find((a) => a.id === t.accountId)?.name, categories.find((c) => c.id === t.categoryId)?.name, t.merchant, t.note, t.countsTowardBudget ? "是" : "否"]);
  return "\ufeff" + [["日期", "时间", "类型", "状态", "金额", "账户", "分类", "商家/来源", "备注", "计入周预算"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
function blobToDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }
function dataUrlToBlob(value: string) { const [header, body] = value.split(","); const type = /data:(.*?);/.exec(header)?.[1] ?? "application/octet-stream"; const binary = atob(body); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return new Blob([bytes], { type }); }
