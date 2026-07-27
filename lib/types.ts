export type Cents = number;
export type LocalDate = `${number}-${number}-${number}`;

export type TransactionType =
  | "expense"
  | "income"
  | "transfer"
  | "refund"
  | "loan_out"
  | "loan_repayment"
  | "salary_payment"
  | "installment_payment"
  | "adjustment";

export interface Account {
  id: string;
  name: string;
  icon: string;
  openingBalanceCents: Cents;
  balanceAsOf: LocalDate;
  hidden: boolean;
  sort: number;
}

export interface Category {
  id: string;
  kind: "income" | "expense";
  name: string;
  parentId?: string;
  icon: string;
  defaultBudget: boolean;
  archived: boolean;
  sort: number;
}

export interface LedgerTransaction {
  id: string;
  type: TransactionType;
  status: "posted" | "planned" | "void";
  amountCents: Cents;
  date: LocalDate;
  time: string;
  accountId: string;
  toAccountId?: string;
  categoryId?: string;
  merchant?: string;
  note?: string;
  countsTowardBudget: boolean;
  rigid: boolean;
  reimbursable: boolean;
  tags: string[];
  attachmentIds: string[];
  linkedId?: string;
  adjustmentDirection?: "in" | "out";
  recurringRuleId?: string;
  receivableId?: string;
  salarySettlementId?: string;
  importBatchId?: string;
  affectsBalance: boolean;
  createdAt: string;
}

export interface SalaryPlan {
  id: string;
  name: string;
  employer: string;
  startDate: LocalDate;
  endDate: LocalDate;
  dailyRateCents: Cents;
  firstPayDate: LocalDate;
  cutoffDay: number;
  payDay: number;
  active: boolean;
}

export interface Attendance {
  id: string;
  planId: string;
  date: LocalDate;
  status: "worked" | "off" | "leave" | "pending" | "not_employed";
  earnedCents: Cents;
  note?: string;
}

export interface SalarySettlement {
  id: string;
  planId: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  attendanceIds: string[];
  transactionId: string;
  amountCents: Cents;
  baselineCents?: Cents;
  status: "confirmed" | "void";
  createdAt: string;
  updatedAt: string;
}

export interface SalaryAdjustment {
  id: string;
  settlementId: string;
  transactionId: string;
  previousAmountCents: Cents;
  nextAmountCents: Cents;
  reason: string;
  createdAt: string;
}

export interface InstallmentPlan {
  id: string;
  name: string;
  totalCents: Cents;
  accountId: string;
  categoryId: string;
  reminder: boolean;
}

export interface InstallmentItem {
  id: string;
  planId: string;
  sequence: number;
  dueDate: LocalDate;
  amountCents: Cents;
  status: "paid" | "unpaid";
  actualPaidDate?: LocalDate;
  reserved: boolean;
  historicalSnapshot: boolean;
}

export interface Reserve {
  id: string;
  name: string;
  amountCents: Cents;
  kind: "living" | "emergency" | "other";
  active: boolean;
}

export interface RecurringRule {
  id: string;
  name: string;
  type: "expense" | "income";
  amountCents: Cents;
  accountId: string;
  categoryId: string;
  frequency: "weekly" | "monthly" | "yearly";
  interval: number;
  nextDate: LocalDate;
  endDate?: LocalDate;
  countsTowardBudget: boolean;
  rigid: boolean;
  active: boolean;
  createdAt: string;
}

export interface FinancialGoal {
  id: string;
  name: string;
  targetCents: Cents;
  savedCents: Cents;
  targetDate: LocalDate;
  kind: "living" | "emergency" | "education" | "purchase" | "other";
  active: boolean;
  createdAt: string;
}

export interface Receivable {
  id: string;
  name: string;
  counterparty: string;
  direction: "owed_to_me" | "i_owe" | "reimbursement";
  totalCents: Cents;
  settledCents: Cents;
  dueDate: LocalDate;
  status: "open" | "settled";
  transactionIds: string[];
  note?: string;
  createdAt: string;
}

export interface ReconciliationSnapshot {
  id: string;
  accountId: string;
  date: LocalDate;
  bookBalanceCents: Cents;
  actualBalanceCents: Cents;
  differenceCents: Cents;
  adjustmentTransactionId?: string;
  note?: string;
  createdAt: string;
}

export interface ImportBatch {
  id: string;
  source: "wechat" | "alipay" | "bank" | "generic";
  fileName: string;
  importedAt: string;
  recordCount: number;
  duplicateCount: number;
  transactionIds: string[];
  status: "imported" | "reverted";
}

export interface BudgetSettings {
  id: "main";
  weeklyCapCents: Cents;
  weekStartsOn: 0 | 1 | 6;
  rolloverMode: "rollover" | "reset";
  safetyMode: "30d" | "60d" | "school" | "custom";
  customSafetyCents: Cents;
  schoolDate: LocalDate;
  customForecastDate: LocalDate;
  categoryLimits: Record<string, Cents>;
  budgetPeriod?: "weekly" | "monthly" | "custom";
  customBudgetStart?: LocalDate;
  customBudgetEnd?: LocalDate;
}

export interface AppSetting {
  key: string;
  value: unknown;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export type SyncEntity =
  | "accounts"
  | "categories"
  | "transactions"
  | "salaryPlans"
  | "attendance"
  | "salarySettlements"
  | "salaryAdjustments"
  | "installmentPlans"
  | "installmentItems"
  | "reserves"
  | "recurringRules"
  | "financialGoals"
  | "receivables"
  | "reconciliations"
  | "importBatches"
  | "budgets"
  | "settings"
  | "attachments";

export interface SyncQueueItem {
  id: string;
  entityType: SyncEntity;
  recordId: string;
  operation: "put" | "delete";
  localUpdatedAt: number;
  deviceId: string;
  attempts: number;
  lastError?: string;
}

export interface SyncMetaRecord {
  key: string;
  value: unknown;
}

export interface LedgerSnapshot {
  accounts: Account[];
  categories: Category[];
  transactions: LedgerTransaction[];
  salaryPlans: SalaryPlan[];
  attendance: Attendance[];
  salarySettlements: SalarySettlement[];
  salaryAdjustments: SalaryAdjustment[];
  installmentPlans: InstallmentPlan[];
  installmentItems: InstallmentItem[];
  reserves: Reserve[];
  recurringRules: RecurringRule[];
  financialGoals: FinancialGoal[];
  receivables: Receivable[];
  reconciliations: ReconciliationSnapshot[];
  importBatches: ImportBatch[];
  budget: BudgetSettings;
}

export const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const asCents = (yuan: number): Cents => Math.round(yuan * 100);
export const formatMoney = (value: Cents) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value / 100);
