import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, exportBackup, exportMonthlyTransactionsCsv, exportTransactionsCsv, importBackup, initializeDatabase, listLegacyCustomizations, loadSnapshot, queueLocalChange, queuePristineSeedData, resetDatabase } from "../lib/db";

describe("IndexedDB 持久化与备份", () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  it("首次启动写入完整示例数据且刷新后仍可读取", async () => {
    await initializeDatabase(); const first = await loadSnapshot(); const second = await loadSnapshot();
    expect(first.accounts.find((a) => a.id === "acc-lqt")?.openingBalanceCents).toBe(135855);
    expect(first.attendance).toHaveLength(39); expect(second.transactions[0].id).toBe("tx-ps-history");
  });
  it("JSON备份带版本号，CSV包含中文表头", async () => {
    await initializeDatabase(); const snapshot = await loadSnapshot(); const backup = JSON.parse(await exportBackup());
    expect(backup.schemaVersion).toBe(2); expect(backup.transactions).toHaveLength(1);
    expect(exportTransactionsCsv(snapshot.transactions, snapshot.accounts, snapshot.categories)).toContain("\"日期\",\"时间\"");
  });
  it("月流水导出只包含选中月份，覆盖跨年、月首月末且不改变原数据", async () => {
    await initializeDatabase(); const snapshot = await loadSnapshot();
    const base = snapshot.transactions[0];
    const rows = [
      { ...base, id: "previous", date: "2025-12-31" as const, note: "上个月" },
      { ...base, id: "last", date: "2026-01-31" as const, note: '月末,"测试"' },
      { ...base, id: "first", date: "2026-01-01" as const, note: "月初" },
      { ...base, id: "next", date: "2026-02-01" as const, note: "下个月" },
    ];
    const before = JSON.stringify(rows);
    const csv = exportMonthlyTransactionsCsv(rows, snapshot.accounts, snapshot.categories, "2026-01");
    expect(csv).toContain('"2026-01-01"'); expect(csv).toContain('"2026-01-31"');
    expect(csv).not.toContain("上个月"); expect(csv).not.toContain("下个月");
    expect(csv).toContain('"月末,""测试"""');
    expect(csv.indexOf("月初")).toBeLessThan(csv.indexOf("月末"));
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("空月份只导出表头，无效月份不会导出全部账目", () => {
    expect(exportMonthlyTransactionsCsv([], [], [], "2024-02").split("\n")).toHaveLength(1);
    for (const month of ["", "2026-13", "2026-1", "2026-00"]) {
      expect(() => exportMonthlyTransactionsCsv([], [], [], month)).toThrow("请选择有效月份");
    }
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
  it("v3 数据库包含同步队列、工资结算与财务计划表", async () => {
    await initializeDatabase();
    expect(db.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      "syncQueue", "syncMeta", "salarySettlements", "salaryAdjustments",
      "recurringRules", "financialGoals", "receivables", "reconciliations", "importBatches",
    ]));
    expect(db.verno).toBe(3);
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
  it("v2备份可以恢复新增财务计划实体和月度结账设置", async () => {
    await initializeDatabase();
    await db.financialGoals.add({
      id: "goal-test", name: "学费", targetCents: 100000, savedCents: 20000,
      targetDate: "2026-09-01", kind: "education", active: true, createdAt: "now",
    });
    await db.settings.put({ key: "monthClose:2026-07", value: { netCents: 50000, closedAt: "now" } });
    const backup = await exportBackup();
    await db.financialGoals.clear();
    await db.settings.delete("monthClose:2026-07");
    await importBackup(backup, "merge");
    expect(await db.financialGoals.get("goal-test")).toMatchObject({ savedCents: 20000 });
    expect(await db.settings.get("monthClose:2026-07")).toBeTruthy();
  });
});
