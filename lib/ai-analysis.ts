import {
  calculateSafetyLine,
  calculateSalarySnapshot,
  calculateWeeklyBudget,
  currentAvailable,
  dailyConsumptionTrend,
  monthBounds,
  monthlyCategorySpendingTrend,
  monthlyFinanceSummary,
  salaryExpectedPayments,
  summarizeInstallments,
  weeklySpent,
} from "./calculations";
import type { Cents, LedgerSnapshot, LocalDate } from "./types";

export type AiRiskLevel = "low" | "medium" | "high";
export type AiInsightPriority = "high" | "medium" | "low";

export interface AiAnalysisInput {
  month: string;
  asOf: LocalDate;
  currentCash: {
    availableBalanceCents: Cents;
    safetyLineCents: Cents;
    freeFundsCents: Cents;
    safetyGapCents: Cents;
  };
  monthSummary: {
    incomeCents: Cents;
    expenseCents: Cents;
    netCents: Cents;
    rigidCents: Cents;
    savingsRate: number;
    transactionCount: number;
  };
  previousMonthSummary: {
    incomeCents: Cents;
    expenseCents: Cents;
    netCents: Cents;
    savingsRate: number;
  };
  weeklyBudget: {
    budgetCents: Cents;
    spentCents: Cents;
    remainingCents: Cents;
  };
  salary: {
    earnedCents: Cents;
    paidCents: Cents;
    receivableCents: Cents;
    futureCents: Cents;
    nextExpectedPayDate: LocalDate | null;
    nextExpectedPayCents: Cents;
  };
  installments: {
    remainingCount: number;
    remainingCents: Cents;
    pressure30Cents: Cents;
    pressure60Cents: Cents;
    nextDueDate: LocalDate | null;
  };
  categorySpending: Array<{ category: string; amountCents: Cents }>;
  dailySpending: Array<{ date: LocalDate; amountCents: Cents }>;
  goals: Array<{
    kind: string;
    targetCents: Cents;
    savedCents: Cents;
    targetDate: LocalDate;
  }>;
  receivables: Array<{
    direction: string;
    remainingCents: Cents;
    dueDate: LocalDate;
    overdue: boolean;
  }>;
}

export interface AiAnalysis {
  healthScore: number;
  riskLevel: AiRiskLevel;
  headline: string;
  overview: string;
  insights: Array<{
    title: string;
    finding: string;
    evidence: string;
    action: string;
    priority: AiInsightPriority;
  }>;
  nextActions: string[];
}

export interface AiAnalysisResponse {
  analysis: AiAnalysis;
  generatedAt: string;
  model: string;
}

export async function parseAiAnalysisHttpResponse(response: Response): Promise<AiAnalysisResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let value: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      value = await response.json();
    } catch {
      throw new Error("AI 服务返回了无法识别的响应，请稍后重试");
    }
  }

  if (!response.ok) {
    const message = isRecord(value) && typeof value.error === "string"
      ? value.error
      : response.status === 429
        ? "AI 服务额度不足或请求过于频繁"
        : "AI 分析暂时不可用，请稍后重试";
    throw new Error(message);
  }

  if (!isAiAnalysisResponse(value)) throw new Error("AI 返回的分析格式无效");
  return value;
}

function previousMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 2, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function buildAiAnalysisInput(
  data: LedgerSnapshot,
  month: string,
  asOf: LocalDate,
): AiAnalysisInput {
  const balanceCents = currentAvailable(data.accounts, data.transactions);
  const safety = calculateSafetyLine(data.reserves, data.installmentItems, data.budget, asOf, data.financialGoals);
  const salary = calculateSalarySnapshot(data.salaryPlans, data.attendance, data.transactions, asOf);
  const expectedIncome = data.salaryPlans
    .flatMap((plan) => salaryExpectedPayments(plan, data.attendance))
    .filter((item) => item.date >= asOf)
    .sort((left, right) => left.date.localeCompare(right.date));
  const weekly = calculateWeeklyBudget({
    availableCents: balanceCents,
    safetyCents: safety.totalCents,
    nextIncomeDate: expectedIncome[0]?.date,
    asOf,
    settings: data.budget,
    spentCents: weeklySpent(data.transactions, asOf, data.budget.weekStartsOn),
  });
  const installments = summarizeInstallments(data.installmentItems, asOf);
  const summary = monthlyFinanceSummary(data.transactions, month);
  const prior = monthlyFinanceSummary(data.transactions, previousMonth(month));
  const bounds = monthBounds(month);
  const categories = monthlyCategorySpendingTrend(data.transactions, data.categories, bounds.end);
  const daily = dailyConsumptionTrend(data.transactions, bounds.end, Number(bounds.end.slice(-2)));

  return {
    month,
    asOf,
    currentCash: {
      availableBalanceCents: balanceCents,
      safetyLineCents: safety.totalCents,
      freeFundsCents: Math.max(0, balanceCents - safety.totalCents),
      safetyGapCents: Math.max(0, safety.totalCents - balanceCents),
    },
    monthSummary: {
      ...summary,
      transactionCount: data.transactions.filter((transaction) =>
        transaction.status === "posted"
        && transaction.affectsBalance
        && transaction.date.startsWith(month)
        && transaction.type !== "transfer"
      ).length,
    },
    previousMonthSummary: {
      incomeCents: prior.incomeCents,
      expenseCents: prior.expenseCents,
      netCents: prior.netCents,
      savingsRate: prior.savingsRate,
    },
    weeklyBudget: {
      budgetCents: weekly.budgetCents,
      spentCents: weekly.spentCents,
      remainingCents: weekly.remainingCents,
    },
    salary: {
      ...salary,
      nextExpectedPayDate: expectedIncome[0]?.date ?? null,
      nextExpectedPayCents: expectedIncome[0]?.amountCents ?? 0,
    },
    installments: {
      remainingCount: installments.remainingCount,
      remainingCents: installments.remainingCents,
      pressure30Cents: installments.pressure30Cents,
      pressure60Cents: installments.pressure60Cents,
      nextDueDate: installments.next?.dueDate ?? null,
    },
    categorySpending: categories.series.slice(0, 12).map((item) => ({
      category: item.name.slice(0, 40),
      amountCents: item.totalCents,
    })),
    dailySpending: daily.map((item) => ({ date: item.date, amountCents: item.amountCents })),
    goals: data.financialGoals.filter((goal) => goal.active).slice(0, 12).map((goal) => ({
      kind: goal.kind,
      targetCents: goal.targetCents,
      savedCents: goal.savedCents,
      targetDate: goal.targetDate,
    })),
    receivables: data.receivables.filter((item) => item.status === "open").slice(0, 20).map((item) => ({
      direction: item.direction,
      remainingCents: Math.max(0, item.totalCents - item.settledCents),
      dueDate: item.dueDate,
      overdue: item.dueDate < asOf,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeCents(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= -100_000_000_000 && Number(value) <= 100_000_000_000;
}

function isDate(value: unknown): value is LocalDate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isMoneyRecord(value: unknown, keys: string[]) {
  return isRecord(value)
    && hasExactKeys(value, keys)
    && keys.every((key) => isSafeCents(value[key]));
}

export function isAiAnalysisInput(value: unknown): value is AiAnalysisInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "month", "asOf", "currentCash", "monthSummary", "previousMonthSummary", "weeklyBudget",
    "salary", "installments", "categorySpending", "dailySpending", "goals", "receivables",
  ])) return false;
  if (typeof value.month !== "string" || !/^\d{4}-\d{2}$/.test(value.month) || !isDate(value.asOf)) return false;
  if (!isMoneyRecord(value.currentCash, ["availableBalanceCents", "safetyLineCents", "freeFundsCents", "safetyGapCents"])) return false;
  const monthSummary = value.monthSummary;
  if (!isRecord(monthSummary) || !hasExactKeys(monthSummary, [
    "incomeCents", "expenseCents", "netCents", "rigidCents", "savingsRate", "transactionCount",
  ])) return false;
  if (!["incomeCents", "expenseCents", "netCents", "rigidCents"].every((key) => isSafeCents(monthSummary[key]))) return false;
  if (typeof monthSummary.savingsRate !== "number" || !Number.isFinite(monthSummary.savingsRate)
    || typeof monthSummary.transactionCount !== "number" || !Number.isSafeInteger(monthSummary.transactionCount)) return false;
  const previousMonthSummary = value.previousMonthSummary;
  if (!isRecord(previousMonthSummary) || !hasExactKeys(previousMonthSummary, [
    "incomeCents", "expenseCents", "netCents", "savingsRate",
  ])) return false;
  if (!["incomeCents", "expenseCents", "netCents"].every((key) => isSafeCents(previousMonthSummary[key]))) return false;
  if (typeof previousMonthSummary.savingsRate !== "number" || !Number.isFinite(previousMonthSummary.savingsRate)) return false;
  if (!isMoneyRecord(value.weeklyBudget, ["budgetCents", "spentCents", "remainingCents"])) return false;

  const salary = value.salary;
  if (!isRecord(salary) || !hasExactKeys(salary, [
    "earnedCents", "paidCents", "receivableCents", "futureCents", "nextExpectedPayDate", "nextExpectedPayCents",
  ])) return false;
  if (!["earnedCents", "paidCents", "receivableCents", "futureCents", "nextExpectedPayCents"].every((key) => isSafeCents(salary[key]))) return false;
  if (salary.nextExpectedPayDate !== null && !isDate(salary.nextExpectedPayDate)) return false;

  const installments = value.installments;
  if (!isRecord(installments) || !hasExactKeys(installments, [
    "remainingCount", "remainingCents", "pressure30Cents", "pressure60Cents", "nextDueDate",
  ])) return false;
  if (typeof installments.remainingCount !== "number" || !Number.isSafeInteger(installments.remainingCount)) return false;
  if (!["remainingCents", "pressure30Cents", "pressure60Cents"].every((key) => isSafeCents(installments[key]))) return false;
  if (installments.nextDueDate !== null && !isDate(installments.nextDueDate)) return false;

  if (!Array.isArray(value.categorySpending) || value.categorySpending.length > 12 || !value.categorySpending.every((item) =>
    isRecord(item) && hasExactKeys(item, ["category", "amountCents"])
    && typeof item.category === "string" && item.category.length <= 40 && isSafeCents(item.amountCents)
  )) return false;
  if (!Array.isArray(value.dailySpending) || value.dailySpending.length > 31 || !value.dailySpending.every((item) =>
    isRecord(item) && hasExactKeys(item, ["date", "amountCents"]) && isDate(item.date) && isSafeCents(item.amountCents)
  )) return false;
  if (!Array.isArray(value.goals) || value.goals.length > 12 || !value.goals.every((item) =>
    isRecord(item) && hasExactKeys(item, ["kind", "targetCents", "savedCents", "targetDate"])
    && typeof item.kind === "string" && item.kind.length <= 30
    && isSafeCents(item.targetCents) && isSafeCents(item.savedCents) && isDate(item.targetDate)
  )) return false;
  if (!Array.isArray(value.receivables) || value.receivables.length > 20 || !value.receivables.every((item) =>
    isRecord(item) && hasExactKeys(item, ["direction", "remainingCents", "dueDate", "overdue"])
    && typeof item.direction === "string" && item.direction.length <= 30
    && isSafeCents(item.remainingCents) && isDate(item.dueDate) && typeof item.overdue === "boolean"
  )) return false;
  return true;
}

export function isAiAnalysisResponse(value: unknown): value is AiAnalysisResponse {
  if (!isRecord(value) || typeof value.generatedAt !== "string" || typeof value.model !== "string" || !isRecord(value.analysis)) return false;
  const analysis = value.analysis;
  return Number.isInteger(analysis.healthScore)
    && Number(analysis.healthScore) >= 0
    && Number(analysis.healthScore) <= 100
    && ["low", "medium", "high"].includes(String(analysis.riskLevel))
    && typeof analysis.headline === "string"
    && typeof analysis.overview === "string"
    && Array.isArray(analysis.insights)
    && analysis.insights.every((item) => isRecord(item)
      && typeof item.title === "string"
      && typeof item.finding === "string"
      && typeof item.evidence === "string"
      && typeof item.action === "string"
      && ["high", "medium", "low"].includes(String(item.priority)))
    && Array.isArray(analysis.nextActions)
    && analysis.nextActions.every((item) => typeof item === "string");
}
