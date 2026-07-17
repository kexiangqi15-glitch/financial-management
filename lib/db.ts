import Dexie, { type EntityTable } from "dexie";
import type { Account, AppSetting, AttachmentRecord, Attendance, BudgetSettings, Category, InstallmentItem, InstallmentPlan, LedgerSnapshot, LedgerTransaction, Reserve, SalaryPlan, SyncEntity, SyncMetaRecord, SyncQueueItem } from "./types";
import { uid } from "./types";
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
  syncQueue!: EntityTable<SyncQueueItem, "id">;
  syncMeta!: EntityTable<SyncMetaRecord, "key">;

  constructor() {
    super("qinglan-ledger");
    this.version(1).stores({
      accounts: "id, name, sort", categories: "id, kind, parentId, sort", transactions: "id, type, status, date, accountId, categoryId",
      salaryPlans: "id, active", attendance: "id, planId, date, [planId+date]", installmentPlans: "id", installmentItems: "id, planId, dueDate, status",
      reserves: "id, kind", budgets: "id", settings: "key", attachments: "id",
    });
    this.version(2).stores({
      accounts: "id, name, sort", categories: "id, kind, parentId, sort", transactions: "id, type, status, date, accountId, categoryId",
      salaryPlans: "id, active", attendance: "id, planId, date, [planId+date]", installmentPlans: "id", installmentItems: "id, planId, dueDate, status",
      reserves: "id, kind", budgets: "id", settings: "key", attachments: "id",
      syncQueue: "id, entityType, localUpdatedAt", syncMeta: "key",
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
  const previous = await listAllRecordIdentities();
  await Promise.all([db.accounts.clear(), db.categories.clear(), db.transactions.clear(), db.salaryPlans.clear(), db.attendance.clear(), db.installmentPlans.clear(), db.installmentItems.clear(), db.reserves.clear(), db.budgets.clear(), db.settings.clear(), db.attachments.clear()]);
  await Promise.all(previous.map(({ entityType, recordId }) => queueLocalChange(entityType, recordId, "delete")));
  await initializeDatabase();
  await queueAllLocalData();
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
  const previous = mode === "replace" ? await listAllRecordIdentities() : [];
  await db.transaction("rw", [db.accounts, db.categories, db.transactions, db.salaryPlans, db.attendance, db.installmentPlans, db.installmentItems, db.reserves, db.budgets, db.attachments], async () => {
    if (mode === "replace") await Promise.all([db.accounts.clear(), db.categories.clear(), db.transactions.clear(), db.salaryPlans.clear(), db.attendance.clear(), db.installmentPlans.clear(), db.installmentItems.clear(), db.reserves.clear(), db.budgets.clear(), db.attachments.clear()]);
    await db.accounts.bulkPut(value.accounts ?? []); await db.categories.bulkPut(value.categories ?? []); await db.transactions.bulkPut(value.transactions ?? []);
    await db.salaryPlans.bulkPut(value.salaryPlans ?? []); await db.attendance.bulkPut(value.attendance ?? []); await db.installmentPlans.bulkPut(value.installmentPlans ?? []);
    await db.installmentItems.bulkPut(value.installmentItems ?? []); await db.reserves.bulkPut(value.reserves ?? []); if (value.budget) await db.budgets.put(value.budget);
    if (value.attachments?.length) await db.attachments.bulkPut(value.attachments.map((a) => ({ ...a, blob: dataUrlToBlob(a.blob) })));
  });
  if (mode === "replace") {
    const current = new Set((await listAllRecordIdentities()).map((item) => `${item.entityType}:${item.recordId}`));
    for (const item of previous) if (!current.has(`${item.entityType}:${item.recordId}`)) await queueLocalChange(item.entityType, item.recordId, "delete");
  }
  await queueAllLocalData();
  return { accounts: value.accounts.length, transactions: value.transactions.length };
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
export function exportTransactionsCsv(transactions: LedgerTransaction[], accounts: Account[], categories: Category[]) {
  const rows = transactions.map((t) => [t.date, t.time, t.type, t.status, (t.amountCents / 100).toFixed(2), accounts.find((a) => a.id === t.accountId)?.name, categories.find((c) => c.id === t.categoryId)?.name, t.merchant, t.note, t.countsTowardBudget ? "是" : "否"]);
  return "\ufeff" + [["日期", "时间", "类型", "状态", "金额", "账户", "分类", "商家/来源", "备注", "计入周预算"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
function blobToDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }
function dataUrlToBlob(value: string) { const [header, body] = value.split(","); const type = /data:(.*?);/.exec(header)?.[1] ?? "application/octet-stream"; const binary = atob(body); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return new Blob([bytes], { type }); }

export const syncEntityNames: SyncEntity[] = [
  "accounts", "categories", "transactions", "salaryPlans", "attendance", "installmentPlans", "installmentItems", "reserves", "budgets", "settings", "attachments",
];

export function getDeviceId() {
  if (typeof localStorage === "undefined") return "test-device";
  const existing = localStorage.getItem("qinglan-device-id");
  if (existing) return existing;
  const created = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : uid("device");
  localStorage.setItem("qinglan-device-id", created);
  return created;
}

let lastClock = 0;
export function nextSyncClock() {
  lastClock = Math.max(Date.now(), lastClock + 1);
  return lastClock;
}

export async function queueLocalChange(entityType: SyncEntity, recordId: string, operation: "put" | "delete" = "put") {
  if (entityType === "settings" && recordId === "initialized") return;
  const localUpdatedAt = nextSyncClock();
  const deviceId = getDeviceId();
  const item: SyncQueueItem = { id: `${entityType}:${recordId}`, entityType, recordId, operation, localUpdatedAt, deviceId, attempts: 0 };
  await db.transaction("rw", [db.syncQueue, db.syncMeta], async () => {
    await db.syncQueue.put(item);
    await db.syncMeta.put({ key: `record:${entityType}:${recordId}`, value: { clock: localUpdatedAt, deviceId } });
  });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("qinglan:local-change"));
}

export async function getLocalRecord(entityType: SyncEntity, recordId: string): Promise<unknown> {
  const table = db.table(entityType);
  return table.get(recordId);
}

export async function putRemoteRecord(entityType: SyncEntity, recordId: string, value: unknown, stamp: { clock: number; deviceId: string }) {
  const table = db.table(entityType);
  await db.transaction("rw", [table, db.syncMeta], async () => {
    await table.put(value);
    await db.syncMeta.put({ key: `record:${entityType}:${recordId}`, value: stamp });
  });
  notifyDataChanged();
}

export async function deleteRemoteRecord(entityType: SyncEntity, recordId: string, stamp: { clock: number; deviceId: string }) {
  const table = db.table(entityType);
  await db.transaction("rw", [table, db.syncMeta], async () => {
    await table.delete(recordId);
    await db.syncMeta.put({ key: `record:${entityType}:${recordId}`, value: stamp });
  });
  notifyDataChanged();
}

export async function getRecordStamp(entityType: SyncEntity, recordId: string) {
  const meta = await db.syncMeta.get(`record:${entityType}:${recordId}`);
  return meta?.value as { clock: number; deviceId: string } | undefined;
}

export async function listAllRecordIdentities() {
  const result: Array<{ entityType: SyncEntity; recordId: string }> = [];
  for (const entityType of syncEntityNames) {
    const keys = await db.table(entityType).toCollection().primaryKeys();
    for (const key of keys) {
      const recordId = String(key);
      if (entityType !== "settings" || recordId !== "initialized") result.push({ entityType, recordId });
    }
  }
  return result;
}

export async function queueAllLocalData(filter?: Set<string>) {
  const identities = await listAllRecordIdentities();
  for (const identity of identities) {
    const compound = `${identity.entityType}:${identity.recordId}`;
    if (!filter || filter.has(compound)) await queueLocalChange(identity.entityType, identity.recordId, "put");
  }
  return identities.length;
}

export async function isPristineSeedDatabase() {
  return (await listLegacyCustomizations()).length === 0;
}

export interface LegacyCustomization {
  entityType: SyncEntity;
  recordId: string;
  operation: "put" | "delete";
  value?: unknown;
}

export async function listLegacyCustomizations(): Promise<LegacyCustomization[]> {
  const baseline: Partial<Record<SyncEntity, unknown[]>> = {
    accounts: seed.accounts,
    categories: seed.categories,
    transactions: seed.transactions,
    salaryPlans: seed.salaryPlans,
    attendance: seed.attendance,
    installmentPlans: seed.installmentPlans,
    installmentItems: seed.installmentItems,
    reserves: seed.reserves,
    budgets: [seed.budget],
    settings: [],
    attachments: [],
  };
  const changes: LegacyCustomization[] = [];
  for (const entityType of syncEntityNames) {
    const localRecords = (await db.table(entityType).toArray()).filter((record) => !(entityType === "settings" && (record as AppSetting).key === "initialized"));
    const baselineRecords = baseline[entityType] ?? [];
    const primaryKey = entityType === "settings" ? "key" : "id";
    const localById = new Map(localRecords.map((record) => [String((record as Record<string, unknown>)[primaryKey]), record]));
    const baselineById = new Map(baselineRecords.map((record) => [String((record as Record<string, unknown>)[primaryKey]), record]));
    for (const [recordId, value] of localById) {
      const original = baselineById.get(recordId);
      if (!original || canonicalJson(value) !== canonicalJson(original)) changes.push({ entityType, recordId, operation: "put", value });
    }
    for (const recordId of baselineById.keys()) if (!localById.has(recordId)) changes.push({ entityType, recordId, operation: "delete" });
  }
  return changes;
}

function notifyDataChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("qinglan:data-changed"));
}

function canonicalJson(value: unknown): string {
  if (value instanceof Blob) return `[Blob:${value.type}:${value.size}]`;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
