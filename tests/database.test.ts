import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, exportBackup, exportTransactionsCsv, initializeDatabase, listLegacyCustomizations, loadSnapshot, queueLocalChange, queuePristineSeedData, resetDatabase } from "../lib/db";

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
  it("本地修改和删除会写入可重试的增量同步队列", async () => {
    await initializeDatabase();
    await db.accounts.update("acc-lqt", { openingBalanceCents: 135305 });
    await queueLocalChange("accounts", "acc-lqt");
    const put = await db.syncQueue.get("accounts:acc-lqt");
    expect(put?.operation).toBe("put");
    await db.transactions.delete("tx-ps-history");
    await queueLocalChange("transactions", "tx-ps-history", "delete");
    expect((await db.syncQueue.get("transactions:tx-ps-history"))?.operation).toBe("delete");
  });
  it("v2 数据库包含同步队列与版本元数据表", async () => {
    await initializeDatabase();
    expect(db.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["syncQueue", "syncMeta"]));
    expect(db.verno).toBe(2);
  });
  it("升级迁移能识别旧设备上改过的同 ID 数据，避免被另一设备覆盖", async () => {
    await initializeDatabase();
    await db.accounts.update("acc-lqt", { openingBalanceCents: 135305 });
    const changes = await listLegacyCustomizations();
    expect(changes).toContainEqual(expect.objectContaining({ entityType: "accounts", recordId: "acc-lqt", operation: "put" }));
  });
  it("纯示例数据首次上传使用低优先级时钟，不会压过同时迁移的真实修改", async () => {
    await initializeDatabase();
    await queuePristineSeedData();
    expect((await db.syncQueue.get("accounts:acc-lqt"))?.localUpdatedAt).toBe(1);
  });
});
