import { db, queueLocalChange } from "./db";
import { addDays, calculateSettlementAmount } from "./calculations";
import type {
  Attendance,
  LedgerTransaction,
  LocalDate,
  SalaryAdjustment,
  SalaryPlan,
  SalarySettlement,
} from "./types";
import { uid } from "./types";

export async function ensureLegacySalarySettlements(
  plan: SalaryPlan,
  attendance: Attendance[],
  transactions: LedgerTransaction[],
  settlements: SalarySettlement[],
) {
  const linkedTransactions = new Set(settlements.map((settlement) => settlement.transactionId));
  const claimedAttendance = new Set(settlements.flatMap((settlement) => settlement.attendanceIds));
  const legacy = transactions
    .filter((transaction) => transaction.type === "salary_payment" && !linkedTransactions.has(transaction.id))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!legacy.length) return false;

  const queued: Array<{ entity: "transactions" | "salarySettlements"; id: string }> = [];
  await db.transaction("rw", [db.transactions, db.salarySettlements], async () => {
    for (const transaction of legacy) {
      const included = attendance.filter((item) =>
        item.planId === plan.id
        && item.date <= transaction.date
        && item.status === "worked"
        && !claimedAttendance.has(item.id)
      );
      included.forEach((item) => claimedAttendance.add(item.id));
      const attendanceTotal = included.reduce((sum, item) => sum + item.earnedCents, 0);
      const settlementId = `settlement-${transaction.id}`;
      const dates = included.map((item) => item.date).sort();
      const now = new Date().toISOString();
      await db.salarySettlements.put({
        id: settlementId,
        planId: plan.id,
        periodStart: dates[0] ?? plan.startDate,
        periodEnd: dates.at(-1) ?? transaction.date,
        attendanceIds: included.map((item) => item.id),
        transactionId: transaction.id,
        amountCents: transaction.amountCents,
        baselineCents: transaction.amountCents - attendanceTotal,
        status: transaction.status === "void" ? "void" : "confirmed",
        createdAt: transaction.createdAt,
        updatedAt: now,
      });
      await db.transactions.update(transaction.id, { salarySettlementId: settlementId });
      queued.push({ entity: "salarySettlements", id: settlementId }, { entity: "transactions", id: transaction.id });
    }
  });
  for (const item of queued) await queueLocalChange(item.entity, item.id);
  return true;
}

export async function setAttendanceStatus(
  plan: SalaryPlan,
  attendanceId: string,
  status: Attendance["status"],
) {
  const item = await db.attendance.get(attendanceId);
  if (!item || item.planId !== plan.id) return;
  const safeStatus = item.date > plan.endDate ? "not_employed" : status;
  await db.attendance.update(attendanceId, {
    status: safeStatus,
    earnedCents: safeStatus === "worked" ? plan.dailyRateCents : 0,
  });
  await queueLocalChange("attendance", attendanceId);
  await recalculateSalarySettlements(plan, `修改 ${item.date} 考勤为${attendanceStatusLabel(safeStatus)}`);
}

export async function setSalaryEndDate(plan: SalaryPlan, nextEndDate: LocalDate) {
  if (nextEndDate < plan.startDate) throw new Error("最后工作日不能早于开始日期");
  const existing = await db.attendance.where("planId").equals(plan.id).toArray();
  const byDate = new Map(existing.map((item) => [item.date, item]));
  const changedAttendance: string[] = [];
  const additions: Attendance[] = [];

  if (nextEndDate < plan.endDate) {
    for (const item of existing) {
      if (item.date > nextEndDate && item.status !== "not_employed") {
        await db.attendance.update(item.id, { status: "not_employed", earnedCents: 0 });
        changedAttendance.push(item.id);
      }
    }
  } else if (nextEndDate > plan.endDate) {
    for (let date = addDays(plan.endDate, 1); date <= nextEndDate; date = addDays(date, 1)) {
      const item = byDate.get(date);
      if (item) {
        await db.attendance.update(item.id, { status: "pending", earnedCents: 0 });
        changedAttendance.push(item.id);
      } else {
        const created: Attendance = {
          id: uid("attendance"),
          planId: plan.id,
          date,
          status: "pending",
          earnedCents: 0,
        };
        additions.push(created);
      }
    }
  }

  if (additions.length) await db.attendance.bulkAdd(additions);
  await db.salaryPlans.update(plan.id, { endDate: nextEndDate });
  await queueLocalChange("salaryPlans", plan.id);
  for (const id of [...changedAttendance, ...additions.map((item) => item.id)]) await queueLocalChange("attendance", id);
  await recalculateSalarySettlements({ ...plan, endDate: nextEndDate }, `最后工作日调整为 ${nextEndDate}`);
}

export async function confirmSalarySettlement(
  plan: SalaryPlan,
  attendance: Attendance[],
  settlements: SalarySettlement[],
  accountId: string,
  categoryId: string | undefined,
  asOf: LocalDate,
) {
  const linked = new Set(settlements.flatMap((settlement) => settlement.attendanceIds));
  const included = attendance.filter((item) =>
    item.planId === plan.id
    && item.status === "worked"
    && item.date <= asOf
    && item.date <= plan.endDate
    && !linked.has(item.id)
  );
  const amountCents = included.reduce((sum, item) => sum + item.earnedCents, 0);
  if (!included.length || amountCents <= 0) return null;
  const transactionId = uid("salary");
  const settlementId = uid("settlement");
  const now = new Date().toISOString();
  const dates = included.map((item) => item.date).sort();
  const transaction: LedgerTransaction = {
    id: transactionId,
    type: "salary_payment",
    status: "posted",
    amountCents,
    date: asOf,
    time: new Date().toTimeString().slice(0, 5),
    accountId,
    categoryId,
    merchant: plan.employer,
    note: "工资结算确认到账",
    countsTowardBudget: false,
    rigid: false,
    reimbursable: false,
    tags: ["工资"],
    attachmentIds: [],
    salarySettlementId: settlementId,
    affectsBalance: true,
    createdAt: now,
  };
  const settlement: SalarySettlement = {
    id: settlementId,
    planId: plan.id,
    periodStart: dates[0],
    periodEnd: dates.at(-1) ?? dates[0],
    attendanceIds: included.map((item) => item.id),
    transactionId,
    amountCents,
    baselineCents: 0,
    status: "confirmed",
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction("rw", [db.transactions, db.salarySettlements], async () => {
    await db.transactions.add(transaction);
    await db.salarySettlements.add(settlement);
  });
  await queueLocalChange("transactions", transactionId);
  await queueLocalChange("salarySettlements", settlementId);
  return settlement;
}

export async function recalculateSalarySettlements(plan: SalaryPlan, reason: string) {
  const [attendance, settlements] = await Promise.all([
    db.attendance.where("planId").equals(plan.id).toArray(),
    db.salarySettlements.where("planId").equals(plan.id).toArray(),
  ]);
  const changed: Array<{ settlementId: string; transactionId: string; adjustmentId: string }> = [];
  await db.transaction("rw", [db.salarySettlements, db.salaryAdjustments, db.transactions], async () => {
    for (const settlement of settlements) {
      const nextAmountCents = Math.max(0, calculateSettlementAmount(settlement, attendance, plan));
      if (nextAmountCents === settlement.amountCents) continue;
      const adjustment: SalaryAdjustment = {
        id: uid("salary-adjustment"),
        settlementId: settlement.id,
        transactionId: settlement.transactionId,
        previousAmountCents: settlement.amountCents,
        nextAmountCents,
        reason,
        createdAt: new Date().toISOString(),
      };
      await db.salarySettlements.update(settlement.id, {
        amountCents: nextAmountCents,
        status: nextAmountCents === 0 ? "void" : "confirmed",
        updatedAt: adjustment.createdAt,
      });
      await db.transactions.update(settlement.transactionId, {
        amountCents: nextAmountCents,
        status: nextAmountCents === 0 ? "void" : "posted",
      });
      await db.salaryAdjustments.add(adjustment);
      changed.push({ settlementId: settlement.id, transactionId: settlement.transactionId, adjustmentId: adjustment.id });
    }
  });
  for (const item of changed) {
    await queueLocalChange("salarySettlements", item.settlementId);
    await queueLocalChange("transactions", item.transactionId);
    await queueLocalChange("salaryAdjustments", item.adjustmentId);
  }
  return changed.length;
}

export function attendanceStatusLabel(status: Attendance["status"]) {
  return {
    worked: "出勤",
    off: "休息",
    leave: "请假",
    pending: "待确认",
    not_employed: "未在职",
  }[status];
}
