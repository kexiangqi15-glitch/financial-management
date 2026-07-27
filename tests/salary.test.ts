import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { calculateAccountBalances, calculateSalarySnapshot } from "../lib/calculations";
import { db, initializeDatabase, loadSnapshot } from "../lib/db";
import { confirmSalarySettlement, setAttendanceStatus, setSalaryEndDate } from "../lib/salary";

describe("灵活考勤、离职日期与工资联动", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await initializeDatabase();
  });

  it("任意日期可切换休息和出勤并立即重算工资", async () => {
    const plan = (await db.salaryPlans.get("salary-summer"))!;
    await setAttendanceStatus(plan, "attendance-1", "off");
    expect(await db.attendance.get("attendance-1")).toMatchObject({ status: "off", earnedCents: 0 });
    let snapshot = await loadSnapshot();
    expect(calculateSalarySnapshot(snapshot.salaryPlans, snapshot.attendance, snapshot.transactions, "2026-07-16").earnedCents).toBe(32000);

    await setAttendanceStatus(plan, "attendance-1", "worked");
    snapshot = await loadSnapshot();
    expect(calculateSalarySnapshot(snapshot.salaryPlans, snapshot.attendance, snapshot.transactions, "2026-07-16").earnedCents).toBe(40000);
  });

  it("提前结束后停止计薪，延长时恢复日期默认为待确认", async () => {
    const plan = (await db.salaryPlans.get("salary-summer"))!;
    await setSalaryEndDate(plan, "2026-07-15");
    expect(await db.attendance.get("attendance-5")).toMatchObject({ status: "not_employed", earnedCents: 0 });

    const shortened = (await db.salaryPlans.get(plan.id))!;
    await setSalaryEndDate(shortened, "2026-07-17");
    expect(await db.attendance.get("attendance-5")).toMatchObject({ status: "pending", earnedCents: 0 });
    expect(await db.attendance.get("attendance-6")).toMatchObject({ status: "pending", earnedCents: 0 });
    expect(await db.attendance.get("attendance-7")).toMatchObject({ status: "not_employed", earnedCents: 0 });
  });

  it("修改已结算考勤时只按差额调整到账流水和账户余额", async () => {
    const snapshot = await loadSnapshot();
    const plan = snapshot.salaryPlans[0];
    const settlement = await confirmSalarySettlement(
      plan,
      snapshot.attendance,
      snapshot.salarySettlements,
      "acc-lqt",
      "income-工资-暑假工工资",
      "2026-07-16",
    );
    expect(settlement?.amountCents).toBe(40000);
    const before = calculateAccountBalances(snapshot.accounts, await db.transactions.toArray())["acc-lqt"];

    await setAttendanceStatus(plan, "attendance-1", "off");
    const transaction = await db.transactions.get(settlement!.transactionId);
    const after = calculateAccountBalances(snapshot.accounts, await db.transactions.toArray())["acc-lqt"];
    expect(transaction).toMatchObject({ amountCents: 32000, status: "posted" });
    expect(after - before).toBe(-8000);
    expect(await db.salaryAdjustments.count()).toBe(1);
  });

  it("已结算工资重算为零时保留流水但标记为撤销", async () => {
    const snapshot = await loadSnapshot();
    const plan = snapshot.salaryPlans[0];
    const settlement = await confirmSalarySettlement(
      plan,
      snapshot.attendance,
      snapshot.salarySettlements,
      "acc-lqt",
      "income-工资-暑假工工资",
      "2026-07-12",
    );
    await setAttendanceStatus(plan, "attendance-1", "leave");
    expect(await db.transactions.get(settlement!.transactionId)).toMatchObject({ amountCents: 0, status: "void" });
    expect(await db.salarySettlements.get(settlement!.id)).toMatchObject({ amountCents: 0, status: "void" });
  });
});
