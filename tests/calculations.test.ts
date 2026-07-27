import { describe, expect, it } from "vitest";
import {
  calculateAccountBalances, calculateSafetyLine, calculateSalarySnapshot, calculateWeeklyBudget, expectedPayDate,
  dailyConsumptionTrend, forecastCashflow, monthlyCategorySpendingTrend, monthlyFinanceSummary, recurringOccurrences,
  simulatePurchase, summarizeInstallments,
} from "../lib/calculations";
import type { Account, Attendance, BudgetSettings, Category, InstallmentItem, LedgerTransaction, SalaryPlan } from "../lib/types";

const account: Account = { id: "a", name: "零钱通", icon: "wallet", openingBalanceCents: 135855, balanceAsOf: "2026-07-16", hidden: false, sort: 1 };
const baseTx = (partial: Partial<LedgerTransaction>): LedgerTransaction => ({
  id: "t", type: "expense", status: "posted", amountCents: 10000, date: "2026-07-16", time: "12:00", accountId: "a",
  countsTowardBudget: true, rigid: false, reimbursable: false, tags: [], attachmentIds: [], affectsBalance: true, createdAt: "now", ...partial,
});
const budget: BudgetSettings = { id: "main", weeklyCapCents: 35000, weekStartsOn: 1, rolloverMode: "reset", safetyMode: "30d", customSafetyCents: 0, schoolDate: "2026-09-01", customForecastDate: "2026-09-15", categoryLimits: {} };

describe("账户与交易", () => {
  it("余额快照前历史支出不会二次扣款", () => {
    const balances = calculateAccountBalances([account], [baseTx({ date: "2026-07-15", amountCents: 35800, affectsBalance: false })]);
    expect(balances.a).toBe(135855);
  });
  it("转账只改变账户分布且总额不变", () => {
    const second = { ...account, id: "b", openingBalanceCents: 0 };
    const balances = calculateAccountBalances([account, second], [baseTx({ type: "transfer", amountCents: 20000, toAccountId: "b" })]);
    expect(balances.a).toBe(115855); expect(balances.b).toBe(20000); expect(balances.a + balances.b).toBe(135855);
  });
  it("退款返还账户余额", () => expect(calculateAccountBalances([account], [baseTx({ type: "refund", amountCents: 2000 })]).a).toBe(137855));
  it("对账差额调整支持增加与减少余额", () => {
    expect(calculateAccountBalances([account], [baseTx({ type: "adjustment", adjustmentDirection: "in", amountCents: 500 })]).a).toBe(136355);
    expect(calculateAccountBalances([account], [baseTx({ type: "adjustment", adjustmentDirection: "out", amountCents: 500 })]).a).toBe(135355);
  });
  it("近30天每日消费跨月补零、排除转账并冲减退款", () => {
    const trend = dailyConsumptionTrend([
      baseTx({ id: "old", date: "2026-06-30", amountCents: 9999 }),
      baseTx({ id: "expense", date: "2026-07-01", amountCents: 5000 }),
      baseTx({ id: "refund", type: "refund", date: "2026-07-01", amountCents: 1200 }),
      baseTx({ id: "transfer", type: "transfer", date: "2026-07-02", amountCents: 3000 }),
      baseTx({ id: "installment", type: "installment_payment", date: "2026-07-30", amountCents: 35800 }),
      baseTx({ id: "void", status: "void", date: "2026-07-30", amountCents: 10000 }),
    ], "2026-07-30", 30);
    expect(trend).toHaveLength(30);
    expect(trend[0]).toEqual({ date: "2026-07-01", amountCents: 3800 });
    expect(trend[1]).toEqual({ date: "2026-07-02", amountCents: 0 });
    expect(trend[29]).toEqual({ date: "2026-07-30", amountCents: 35800 });
  });
  it("月度分类折线覆盖完整自然月并按类别汇总", () => {
    const categories: Category[] = [
      { id: "meal", kind: "expense", name: "正餐", icon: "Utensils", defaultBudget: true, archived: false, sort: 1 },
      { id: "traffic", kind: "expense", name: "交通", icon: "Bus", defaultBudget: true, archived: false, sort: 2 },
    ];
    const trend = monthlyCategorySpendingTrend([
      baseTx({ id: "meal-1", categoryId: "meal", date: "2026-07-02", amountCents: 1500 }),
      baseTx({ id: "meal-2", categoryId: "meal", date: "2026-07-26", amountCents: 2500 }),
      baseTx({ id: "traffic-1", categoryId: "traffic", date: "2026-07-02", amountCents: 300 }),
      baseTx({ id: "previous", categoryId: "meal", date: "2026-06-30", amountCents: 9999 }),
      baseTx({ id: "void", categoryId: "traffic", date: "2026-07-03", status: "void", amountCents: 9999 }),
    ], categories, "2026-07-26");
    expect(trend.month).toBe("2026-07");
    expect(trend.days).toHaveLength(31);
    expect(trend.series.map(({ id, totalCents }) => [id, totalCents])).toEqual([["meal", 4000], ["traffic", 300]]);
    expect(trend.days[1].amounts).toEqual({ meal: 1500, traffic: 300 });
    expect(trend.days[30].amounts).toEqual({ meal: 0, traffic: 0 });
  });
});

describe("工资与应收", () => {
  const plan: SalaryPlan = { id: "p", name: "暑假工", employer: "餐饮店", startDate: "2026-07-12", endDate: "2026-08-19", dailyRateCents: 8000, firstPayDate: "2026-08-15", cutoffDay: 15, payDay: 15, active: true };
  const attendance: Attendance[] = [
    { id: "1", planId: "p", date: "2026-07-12", status: "worked", earnedCents: 8000 },
    { id: "2", planId: "p", date: "2026-08-16", status: "worked", earnedCents: 8000 },
  ];
  it("8月15日后工资进入9月15日批次", () => { expect(expectedPayDate(plan, "2026-08-15")).toBe("2026-08-15"); expect(expectedPayDate(plan, "2026-08-16")).toBe("2026-09-15"); });
  it("未到账工资只进入应收", () => expect(calculateSalarySnapshot([plan], attendance, [], "2026-07-16")).toEqual({ earnedCents: 8000, paidCents: 0, receivableCents: 8000, futureCents: 8000 }));
  it("确认到账后减少应收", () => expect(calculateSalarySnapshot([plan], attendance, [baseTx({ type: "salary_payment", amountCents: 8000 })], "2026-07-16").receivableCents).toBe(0));
});

describe("安全线、预算、分期和预测", () => {
  const installments: InstallmentItem[] = [
    { id: "i1", planId: "p", sequence: 1, dueDate: "2026-08-15", amountCents: 35800, status: "unpaid", reserved: true, historicalSnapshot: false },
    { id: "i2", planId: "p", sequence: 2, dueDate: "2026-09-15", amountCents: 35800, status: "unpaid", reserved: false, historicalSnapshot: false },
  ];
  it("30天安全线只计入范围内的分期", () => expect(calculateSafetyLine([{ id: "r", name: "生活与应急", amountCents: 200000, kind: "living", active: true }], installments, budget, "2026-07-16").totalCents).toBe(235800));
  it("资金不足时预算归零并报告缺口", () => expect(calculateWeeklyBudget({ availableCents: 135855, safetyCents: 235800, nextIncomeDate: "2026-08-15", asOf: "2026-07-16", settings: budget, spentCents: 0 })).toMatchObject({ budgetCents: 0, gapCents: 99945 }));
  it("预算建议受350元上限约束", () => expect(calculateWeeklyBudget({ availableCents: 500000, safetyCents: 200000, nextIncomeDate: "2026-07-23", asOf: "2026-07-16", settings: budget, spentCents: 0 }).budgetCents).toBe(35000));
  it("未来余额按场景决定是否包含预计收入", () => { const base = { targetDate: "2026-08-19" as const, asOf: "2026-07-16" as const, currentBalanceCents: 135855, expectedIncome: [{ date: "2026-08-15" as const, amountCents: 280000 }], installments, plannedTransactions: [] }; expect(forecastCashflow({ ...base, includeExpectedIncome: false }).balanceCents).toBe(100055); expect(forecastCashflow({ ...base, includeExpectedIncome: true }).balanceCents).toBe(380055); });
  it("分期压力按30/60/90天汇总", () => expect(summarizeInstallments(installments, "2026-07-16")).toMatchObject({ remainingCount: 2, pressure30Cents: 35800, pressure60Cents: 35800, pressure90Cents: 71600 }));
  it("消费模拟给出确定性风险建议", () => expect(simulatePurchase(10000, 250000, 235800, 20000, 35800)).toMatchObject({ afterBalanceCents: 240000, afterWeeklyCents: 10000, safetyGapCents: 0, recommended: true }));
  it("储蓄目标已存金额会进入安全线", () => {
    const result = calculateSafetyLine([], [], budget, "2026-07-16", [{
      id: "g", name: "学费", targetCents: 100000, savedCents: 30000, targetDate: "2026-09-01",
      kind: "education", active: true, createdAt: "now",
    }]);
    expect(result.totalCents).toBe(30000);
  });
  it("周期账单按月生成预测且不会直接修改当前余额", () => {
    const rule = {
      id: "r", name: "话费", type: "expense" as const, amountCents: 5000, accountId: "a", categoryId: "c",
      frequency: "monthly" as const, interval: 1, nextDate: "2026-07-31" as const,
      countsTowardBudget: true, rigid: true, active: true, createdAt: "now",
    };
    expect(recurringOccurrences(rule, "2026-07-01", "2026-09-30")).toEqual(["2026-07-31", "2026-08-31", "2026-09-30"]);
    expect(forecastCashflow({
      targetDate: "2026-09-30", asOf: "2026-07-16", currentBalanceCents: 100000,
      expectedIncome: [], installments: [], plannedTransactions: [], recurringRules: [rule], includeExpectedIncome: false,
    }).balanceCents).toBe(85000);
  });
  it("月度报告计算净结余、刚性占比和储蓄率", () => {
    const result = monthlyFinanceSummary([
      baseTx({ id: "income", type: "income", amountCents: 100000 }),
      baseTx({ id: "expense", type: "expense", amountCents: 30000, rigid: true }),
      baseTx({ id: "refund", type: "refund", amountCents: 5000 }),
    ], "2026-07");
    expect(result).toMatchObject({ incomeCents: 100000, expenseCents: 25000, netCents: 75000, rigidCents: 30000, savingsRate: 75 });
  });
});
