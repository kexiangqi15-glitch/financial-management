import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, exportBackup, exportTransactionsCsv, initializeDatabase, loadSnapshot, resetDatabase } from "../lib/db";

describe("IndexedDB 持久化与备份", () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  it("首次启动写入完整示例数据且刷新后仍可读取", async () => {
    await initializeDatabase(); const first = await loadSnapshot(); const second = await loadSnapshot();
    expect(first.accounts.find((a) => a.id === "acc-lqt")?.openingBalanceCents).toBe(135855);
    expect(first.attendance).toHaveLength(39); expect(second.transactions[0].id).toBe("tx-ps-history");
  });
  it("JSON备份带版本号，CSV包含中文表头", async () => {
    await initializeDatabase(); const snapshot = await loadSnapshot(); const backup = JSON.parse(await exportBackup());
    expect(backup.schemaVersion).toBe(1); expect(backup.transactions).toHaveLength(1);
    expect(exportTransactionsCsv(snapshot.transactions, snapshot.accounts, snapshot.categories)).toContain("\"日期\",\"时间\"");
  });
  it("清空后可恢复示例数据", async () => { await initializeDatabase(); await db.transactions.clear(); await resetDatabase(); expect((await loadSnapshot()).transactions).toHaveLength(1); });
});
