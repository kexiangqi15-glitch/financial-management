import type {
  Account,
  Attendance,
  BudgetSettings,
  Cents,
  InstallmentItem,
  LedgerTransaction,
  LocalDate,
  Reserve,
  SalaryPlan,
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

export function calculateAccountBalances(accounts: Account[], transactions: LedgerTransaction[]) {
  const balances = Object.fromEntries(accounts.map((a) => [a.id, a.openingBalanceCents])) as Record<string, Cents>;
  for (const tx of transactions) {
    if (tx.status !== "posted" || !tx.affectsBalance) continue;
    const account = accounts.find((a) => a.id === tx.accountId);
    if (!account || tx.date < account.balanceAsOf) continue;
    const incoming = ["income", "refund", "loan_repayment", "salary_payment", "adjustment"].includes(tx.type);
    const outgoing = ["expense", "loan_out", "installment_payment"].includes(tx.type);
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
  attendance.filter((a) => a.planId === plan.id && a.status === "worked").forEach((a) => {
    const date = expectedPayDate(plan, a.date);
    grouped.set(date, (grouped.get(date) ?? 0) + a.earnedCents);
  });
  return [...grouped].map(([date, amountCents]) => ({ date, amountCents })).sort((a, b) => a.date.localeCompare(b.date));
}

export function calculateSalarySnapshot(
  plans: SalaryPlan[], attendance: Attendance[], transactions: LedgerTransaction[], asOf: LocalDate,
) {
  const planIds = new Set(plans.map((p) => p.id));
  const relevant = attendance.filter((a) => planIds.has(a.planId) && a.status === "worked");
  const earnedCents = relevant.filter((a) => a.date <= asOf).reduce((s, a) => s + a.earnedCents, 0);
  const futureCents = relevant.filter((a) => a.date > asOf).reduce((s, a) => s + a.earnedCents, 0);
  const paidCents = transactions
    .filter((t) => t.type === "salary_payment" && t.status === "posted" && t.date <= asOf)
    .reduce((s, t) => s + t.amountCents, 0);
  return { earnedCents, paidCents, receivableCents: Math.max(0, earnedCents - paidCents), futureCents };
}

export function safetyHorizon(asOf: LocalDate, settings: BudgetSettings): LocalDate {
  if (settings.safetyMode === "30d") return addDays(asOf, 30);
  if (settings.safetyMode === "60d") return addDays(asOf, 60);
  if (settings.safetyMode === "school") return settings.schoolDate;
  return asOf;
}

export function calculateSafetyLine(
  reserves: Reserve[], installments: InstallmentItem[], settings: BudgetSettings, asOf: LocalDate,
) {
  if (settings.safetyMode === "custom") return { totalCents: settings.customSafetyCents, reserveCents: settings.customSafetyCents, installmentCents: 0 };
  const reserveCents = reserves.filter((r) => r.active).reduce((s, r) => s + r.amountCents, 0);
  const horizon = safetyHorizon(asOf, settings);
  const installmentCents = installments
    .filter((i) => i.status === "unpaid" && i.dueDate >= asOf && i.dueDate <= horizon)
    .reduce((s, i) => s + i.amountCents, 0);
  return { totalCents: reserveCents + installmentCents, reserveCents, installmentCents };
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
}) {
  const incomeCents = input.includeExpectedIncome
    ? input.expectedIncome.filter((x) => x.date > input.asOf && x.date <= input.targetDate).reduce((s, x) => s + x.amountCents, 0) : 0;
  const installmentCents = input.installments
    .filter((i) => i.status === "unpaid" && i.dueDate > input.asOf && i.dueDate <= input.targetDate)
    .reduce((s, i) => s + i.amountCents, 0);
  const plannedCents = input.plannedTransactions
    .filter((t) => t.status === "planned" && t.date > input.asOf && t.date <= input.targetDate && t.rigid)
    .reduce((s, t) => s + t.amountCents, 0);
  return { balanceCents: input.currentBalanceCents + incomeCents - installmentCents - plannedCents, incomeCents, expenseCents: installmentCents + plannedCents };
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

