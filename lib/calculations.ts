import type {
  Account,
  Attendance,
  BudgetSettings,
  Category,
  Cents,
  FinancialGoal,
  InstallmentItem,
  LedgerTransaction,
  LocalDate,
  RecurringRule,
  Reserve,
  SalaryPlan,
  SalarySettlement,
} from "./types";

const DAY = 86_400_000;
export const parseLocalDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
export const toLocalDate = (date: Date): LocalDate => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}` as LocalDate;
};
export const addDays = (date: LocalDate, days: number) => {
  const next = parseLocalDate(date);
  next.setDate(next.getDate() + days);
  return toLocalDate(next);
};
export const daysBetween = (from: LocalDate, to: LocalDate) =>
  Math.max(0, Math.ceil((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / DAY));

export function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01` as LocalDate;
  const lastDay = new Date(year, monthNumber, 0, 12).getDate();
  return { start, end: `${year}-${String(monthNumber).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` as LocalDate };
}

function addMonths(date: LocalDate, months: number) {
  const parsed = parseLocalDate(date);
  const wantedDay = parsed.getDate();
  parsed.setDate(1);
  parsed.setMonth(parsed.getMonth() + months);
  const lastDay = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0, 12).getDate();
  parsed.setDate(Math.min(wantedDay, lastDay));
  return toLocalDate(parsed);
}

function addYears(date: LocalDate, years: number) {
  const parsed = parseLocalDate(date);
  const month = parsed.getMonth();
  parsed.setFullYear(parsed.getFullYear() + years);
  if (parsed.getMonth() !== month) parsed.setDate(0);
  return toLocalDate(parsed);
}

export function nextRecurringDate(rule: RecurringRule, from = rule.nextDate) {
  const interval = Math.max(1, Math.floor(rule.interval));
  if (rule.frequency === "weekly") return addDays(from, interval * 7);
  if (rule.frequency === "yearly") return addYears(from, interval);
  return addMonths(from, interval);
}

export function recurringOccurrences(rule: RecurringRule, from: LocalDate, to: LocalDate) {
  if (!rule.active || to < rule.nextDate || rule.endDate && rule.nextDate > rule.endDate) return [];
  const dates: LocalDate[] = [];
  let current = rule.nextDate;
  let guard = 0;
  while (current <= to && guard < 500) {
    if (current >= from && (!rule.endDate || current <= rule.endDate)) dates.push(current);
    current = nextRecurringDate(rule, current);
    guard += 1;
  }
  return dates;
}

export function dailyConsumptionTrend(
  transactions: LedgerTransaction[],
  asOf: LocalDate,
  days = 30,
) {
  const periodDays = Math.max(1, Math.floor(days));
  const start = addDays(asOf, -(periodDays - 1));
  const totals = new Map<LocalDate, Cents>();
  for (let offset = 0; offset < periodDays; offset += 1) {
    totals.set(addDays(start, offset), 0);
  }

  for (const transaction of transactions) {
    if (
      transaction.status !== "posted"
      || !transaction.affectsBalance
      || transaction.date < start
      || transaction.date > asOf
    ) continue;

    if (transaction.type === "expense" || transaction.type === "installment_payment") {
      totals.set(transaction.date, (totals.get(transaction.date) ?? 0) + transaction.amountCents);
    } else if (transaction.type === "refund") {
      totals.set(transaction.date, (totals.get(transaction.date) ?? 0) - transaction.amountCents);
    }
  }

  return [...totals].map(([date, amountCents]) => ({
    date,
    amountCents: Math.max(0, amountCents),
  }));
}

export function monthlyCategorySpendingTrend(
  transactions: LedgerTransaction[],
  categories: Category[],
  asOf: LocalDate,
) {
  const [year, month] = asOf.split("-").map(Number);
  const monthPrefix = asOf.slice(0, 7);
  const dayCount = new Date(year, month, 0, 12).getDate();
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const amounts = new Map<LocalDate, Map<string, Cents>>();
  const totals = new Map<string, Cents>();

  for (let day = 1; day <= dayCount; day += 1) {
    const date = `${monthPrefix}-${String(day).padStart(2, "0")}` as LocalDate;
    amounts.set(date, new Map());
  }

  for (const transaction of transactions) {
    if (
      transaction.status !== "posted"
      || !transaction.affectsBalance
      || !transaction.date.startsWith(monthPrefix)
    ) continue;

    let categoryId = transaction.categoryId;
    let direction = 0;
    if (transaction.type === "expense" || transaction.type === "installment_payment") direction = 1;
    if (transaction.type === "refund") {
      direction = -1;
      const original = transaction.linkedId ? transactionById.get(transaction.linkedId) : undefined;
      categoryId = original?.categoryId ?? categoryId;
    }
    if (!direction || !categoryId || categoryById.get(categoryId)?.kind !== "expense") continue;

    const dayAmounts = amounts.get(transaction.date);
    if (!dayAmounts) continue;
    dayAmounts.set(
      categoryId,
      (dayAmounts.get(categoryId) ?? 0) + direction * transaction.amountCents,
    );
  }

  for (const dayAmounts of amounts.values()) {
    for (const [categoryId, amountCents] of dayAmounts) {
      totals.set(categoryId, (totals.get(categoryId) ?? 0) + Math.max(0, amountCents));
    }
  }

  const series = [...totals]
    .filter(([, totalCents]) => totalCents > 0)
    .map(([id, totalCents]) => ({
      id,
      name: categoryById.get(id)?.name ?? "其他",
      totalCents,
    }))
    .sort((left, right) => right.totalCents - left.totalCents || left.name.localeCompare(right.name, "zh-CN"));

  return {
    month: monthPrefix,
    series,
    days: [...amounts].map(([date, dayAmounts]) => ({
      date,
      amounts: Object.fromEntries(
        series.map(({ id }) => [id, Math.max(0, dayAmounts.get(id) ?? 0)]),
      ) as Record<string, Cents>,
    })),
  };
}

export function calculateAccountBalances(accounts: Account[], transactions: LedgerTransaction[]) {
  const balances = Object.fromEntries(accounts.map((a) => [a.id, a.openingBalanceCents])) as Record<string, Cents>;
  for (const tx of transactions) {
    if (tx.status !== "posted" || !tx.affectsBalance) continue;
    const account = accounts.find((a) => a.id === tx.accountId);
    if (!account || tx.date < account.balanceAsOf) continue;
    const incoming = ["income", "refund", "loan_repayment", "salary_payment"].includes(tx.type)
      || (tx.type === "adjustment" && tx.adjustmentDirection !== "out");
    const outgoing = ["expense", "loan_out", "installment_payment"].includes(tx.type)
      || (tx.type === "adjustment" && tx.adjustmentDirection === "out");
    if (incoming) balances[tx.accountId] = (balances[tx.accountId] ?? 0) + tx.amountCents;
    if (outgoing) balances[tx.accountId] = (balances[tx.accountId] ?? 0) - tx.amountCents;
    if (tx.type === "transfer" && tx.toAccountId) {
      balances[tx.accountId] = (balances[tx.accountId] ?? 0) - tx.amountCents;
      balances[tx.toAccountId] = (balances[tx.toAccountId] ?? 0) + tx.amountCents;
    }
  }
  return balances;
}

export function currentAvailable(accounts: Account[], transactions: LedgerTransaction[]) {
  const balances = calculateAccountBalances(accounts, transactions);
  return accounts.filter((a) => !a.hidden).reduce((sum, a) => sum + (balances[a.id] ?? 0), 0);
}

export function expectedPayDate(plan: SalaryPlan, workDate: LocalDate): LocalDate {
  if (workDate <= plan.firstPayDate) return plan.firstPayDate;
  const date = parseLocalDate(workDate);
  let year = date.getFullYear();
  let month = date.getMonth();
  if (date.getDate() > plan.cutoffDay) month += 1;
  const cutoff = new Date(year, month, plan.cutoffDay, 12);
  year = cutoff.getFullYear();
  month = cutoff.getMonth();
  if (plan.payDay < plan.cutoffDay) month += 1;
  return toLocalDate(new Date(year, month, plan.payDay, 12));
}

export function salaryExpectedPayments(plan: SalaryPlan, attendance: Attendance[]) {
  const grouped = new Map<LocalDate, Cents>();
  attendance.filter((a) =>
    a.planId === plan.id
    && a.status === "worked"
    && a.date >= plan.startDate
    && a.date <= plan.endDate
  ).forEach((a) => {
    const date = expectedPayDate(plan, a.date);
    grouped.set(date, (grouped.get(date) ?? 0) + a.earnedCents);
  });
  return [...grouped].map(([date, amountCents]) => ({ date, amountCents })).sort((a, b) => a.date.localeCompare(b.date));
}

export function calculateSalarySnapshot(
  plans: SalaryPlan[], attendance: Attendance[], transactions: LedgerTransaction[], asOf: LocalDate,
) {
  const planIds = new Set(plans.map((p) => p.id));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const relevant = attendance.filter((a) => {
    const plan = planById.get(a.planId);
    return planIds.has(a.planId) && a.status === "worked" && Boolean(plan && a.date >= plan.startDate && a.date <= plan.endDate);
  });
  const earnedCents = relevant.filter((a) => a.date <= asOf).reduce((s, a) => s + a.earnedCents, 0);
  const futureCents = relevant.filter((a) => a.date > asOf).reduce((s, a) => s + a.earnedCents, 0);
  const paidCents = transactions
    .filter((t) => t.type === "salary_payment" && t.status === "posted" && t.date <= asOf)
    .reduce((s, t) => s + t.amountCents, 0);
  return { earnedCents, paidCents, receivableCents: Math.max(0, earnedCents - paidCents), futureCents };
}

export function calculateSettlementAmount(
  settlement: SalarySettlement,
  attendance: Attendance[],
  plan: SalaryPlan,
) {
  const attendanceIds = new Set(settlement.attendanceIds);
  return (settlement.baselineCents ?? 0) + attendance
    .filter((item) =>
      attendanceIds.has(item.id)
      && item.planId === plan.id
      && item.status === "worked"
      && item.date >= plan.startDate
      && item.date <= plan.endDate
    )
    .reduce((sum, item) => sum + item.earnedCents, 0);
}

export function safetyHorizon(asOf: LocalDate, settings: BudgetSettings): LocalDate {
  if (settings.safetyMode === "30d") return addDays(asOf, 30);
  if (settings.safetyMode === "60d") return addDays(asOf, 60);
  if (settings.safetyMode === "school") return settings.schoolDate;
  return asOf;
}

export function calculateSafetyLine(
  reserves: Reserve[], installments: InstallmentItem[], settings: BudgetSettings, asOf: LocalDate,
  goals: FinancialGoal[] = [],
) {
  if (settings.safetyMode === "custom") return { totalCents: settings.customSafetyCents, reserveCents: settings.customSafetyCents, installmentCents: 0 };
  const reserveCents = reserves.filter((r) => r.active).reduce((s, r) => s + r.amountCents, 0);
  const goalCents = goals.filter((goal) => goal.active).reduce((sum, goal) => sum + goal.savedCents, 0);
  const horizon = safetyHorizon(asOf, settings);
  const installmentCents = installments
    .filter((i) => i.status === "unpaid" && i.dueDate >= asOf && i.dueDate <= horizon)
    .reduce((s, i) => s + i.amountCents, 0);
  return { totalCents: reserveCents + goalCents + installmentCents, reserveCents: reserveCents + goalCents, installmentCents, goalCents };
}

export function weekBounds(asOf: LocalDate, startsOn: 0 | 1 | 6) {
  const date = parseLocalDate(asOf);
  const distance = (date.getDay() - startsOn + 7) % 7;
  return { start: addDays(asOf, -distance), end: addDays(asOf, 6 - distance) };
}

export function weeklySpent(transactions: LedgerTransaction[], asOf: LocalDate, startsOn: 0 | 1 | 6) {
  const { start, end } = weekBounds(asOf, startsOn);
  return transactions.filter((t) => t.status === "posted" && t.countsTowardBudget && t.date >= start && t.date <= end)
    .reduce((sum, t) => sum + (t.type === "refund" ? -t.amountCents : ["expense", "installment_payment"].includes(t.type) ? t.amountCents : 0), 0);
}

export function calculateWeeklyBudget(input: {
  availableCents: Cents; safetyCents: Cents; nextIncomeDate?: LocalDate; asOf: LocalDate;
  settings: BudgetSettings; spentCents: Cents; rolloverCents?: Cents;
}) {
  const distributableCents = input.availableCents - input.safetyCents;
  const weeks = Math.max(1, Math.ceil(daysBetween(input.asOf, input.nextIncomeDate ?? addDays(input.asOf, 7)) / 7));
  const automaticCents = Math.max(0, Math.floor(distributableCents / weeks));
  const rollover = input.settings.rolloverMode === "rollover" ? (input.rolloverCents ?? 0) : 0;
  const budgetCents = Math.max(0, Math.min(input.settings.weeklyCapCents, automaticCents) + rollover);
  return {
    distributableCents,
    weeks,
    automaticCents,
    budgetCents,
    spentCents: input.spentCents,
    remainingCents: budgetCents - input.spentCents,
    gapCents: Math.max(0, -distributableCents),
  };
}

export function summarizeInstallments(items: InstallmentItem[], asOf: LocalDate) {
  const unpaid = items.filter((i) => i.status === "unpaid");
  const paid = items.filter((i) => i.status === "paid");
  const within = (days: number) => unpaid.filter((i) => i.dueDate <= addDays(asOf, days)).reduce((s, i) => s + i.amountCents, 0);
  return {
    remainingCount: unpaid.length,
    remainingCents: unpaid.reduce((s, i) => s + i.amountCents, 0),
    paidCents: paid.reduce((s, i) => s + i.amountCents, 0),
    next: unpaid.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0],
    pressure30Cents: within(30), pressure60Cents: within(60), pressure90Cents: within(90),
  };
}

export function forecastCashflow(input: {
  targetDate: LocalDate; asOf: LocalDate; currentBalanceCents: Cents;
  expectedIncome: { date: LocalDate; amountCents: Cents }[];
  installments: InstallmentItem[]; plannedTransactions: LedgerTransaction[]; includeExpectedIncome: boolean;
  recurringRules?: RecurringRule[];
}) {
  const incomeCents = input.includeExpectedIncome
    ? input.expectedIncome.filter((x) => x.date > input.asOf && x.date <= input.targetDate).reduce((s, x) => s + x.amountCents, 0) : 0;
  const installmentCents = input.installments
    .filter((i) => i.status === "unpaid" && i.dueDate > input.asOf && i.dueDate <= input.targetDate)
    .reduce((s, i) => s + i.amountCents, 0);
  const plannedCents = input.plannedTransactions
    .filter((t) => t.status === "planned" && t.date > input.asOf && t.date <= input.targetDate && t.rigid)
    .reduce((s, t) => s + t.amountCents, 0);
  const recurringIncomeCents = input.includeExpectedIncome
    ? (input.recurringRules ?? []).filter((rule) => rule.type === "income")
      .reduce((sum, rule) => sum + recurringOccurrences(rule, addDays(input.asOf, 1), input.targetDate).length * rule.amountCents, 0)
    : 0;
  const recurringExpenseCents = (input.recurringRules ?? []).filter((rule) => rule.type === "expense")
    .reduce((sum, rule) => sum + recurringOccurrences(rule, addDays(input.asOf, 1), input.targetDate).length * rule.amountCents, 0);
  return {
    balanceCents: input.currentBalanceCents + incomeCents + recurringIncomeCents - installmentCents - plannedCents - recurringExpenseCents,
    incomeCents: incomeCents + recurringIncomeCents,
    expenseCents: installmentCents + plannedCents + recurringExpenseCents,
  };
}

export function monthlyFinanceSummary(transactions: LedgerTransaction[], month: string) {
  const posted = transactions.filter((transaction) =>
    transaction.status === "posted"
    && transaction.affectsBalance
    && transaction.date.startsWith(month)
    && transaction.type !== "transfer"
  );
  const incomeCents = posted
    .filter((transaction) => ["income", "salary_payment", "loan_repayment"].includes(transaction.type))
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const expenseCents = posted
    .filter((transaction) => ["expense", "installment_payment", "loan_out"].includes(transaction.type))
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const refundCents = posted
    .filter((transaction) => transaction.type === "refund")
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const rigidCents = posted
    .filter((transaction) => transaction.rigid && ["expense", "installment_payment"].includes(transaction.type))
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const netExpenseCents = Math.max(0, expenseCents - refundCents);
  return {
    incomeCents,
    expenseCents: netExpenseCents,
    netCents: incomeCents - netExpenseCents,
    rigidCents,
    savingsRate: incomeCents > 0 ? Math.round((incomeCents - netExpenseCents) / incomeCents * 100) : 0,
  };
}

export function simulatePurchase(amountCents: Cents, availableCents: Cents, safetyCents: Cents, weeklyRemainingCents: Cents, nextInstallmentCents: Cents) {
  const afterBalanceCents = availableCents - amountCents;
  const afterWeeklyCents = weeklyRemainingCents - amountCents;
  const safetyGapCents = Math.max(0, safetyCents - afterBalanceCents);
  const installmentCovered = afterBalanceCents >= nextInstallmentCents;
  return {
    afterBalanceCents, afterWeeklyCents, safetyGapCents, installmentCovered,
    recommended: safetyGapCents === 0 && afterWeeklyCents >= 0 && installmentCovered,
  };
}
