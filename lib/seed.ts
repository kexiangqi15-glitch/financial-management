import { addDays, toLocalDate } from "./calculations";
import type { Account, Attendance, BudgetSettings, Category, InstallmentItem, InstallmentPlan, LedgerTransaction, Reserve, SalaryPlan } from "./types";

export const accounts: Account[] = [
  { id: "acc-lqt", name: "零钱通", icon: "WalletCards", openingBalanceCents: 135855, balanceAsOf: "2026-07-16", hidden: false, sort: 1 },
  { id: "acc-wechat", name: "微信零钱", icon: "MessageCircle", openingBalanceCents: 0, balanceAsOf: "2026-07-16", hidden: false, sort: 2 },
  { id: "acc-alipay", name: "支付宝", icon: "BadgeDollarSign", openingBalanceCents: 0, balanceAsOf: "2026-07-16", hidden: false, sort: 3 },
  { id: "acc-bank", name: "银行卡", icon: "Landmark", openingBalanceCents: 0, balanceAsOf: "2026-07-16", hidden: false, sort: 4 },
  { id: "acc-cash", name: "现金", icon: "Banknote", openingBalanceCents: 0, balanceAsOf: "2026-07-16", hidden: false, sort: 5 },
  { id: "acc-other", name: "其他账户", icon: "CircleDollarSign", openingBalanceCents: 0, balanceAsOf: "2026-07-16", hidden: false, sort: 6 },
];

const expenseGroups: Record<string, string[]> = {
  "餐饮": ["正餐", "外卖", "餐饮改善", "零食", "水果", "饮料", "咖啡", "奶茶", "茶饮", "纯净水"],
  "日常": ["购物", "日用", "交通", "蔬菜", "通讯", "住房", "居家", "医疗", "快递", "充电", "水卡"],
  "娱乐": ["游戏", "电影", "网吧", "台球", "按摩", "会员", "周边", "旅行", "社交"],
  "学习": ["PS课程", "书籍", "教材", "AI会员", "软件订阅", "考试报名", "打印复印", "办公"],
  "个人护理": ["护肤", "美容", "理发", "服饰", "健身", "运动", "数码"],
  "家庭人情": ["父母", "孩子", "长辈", "亲友", "礼金", "礼物", "捐赠"],
  "特殊支出": ["汽车", "维修", "宠物", "彩票", "烟酒", "其他"],
};
const incomeGroups: Record<string, string[]> = {
  "工资": ["暑假工工资", "正式工资", "奖金", "加班费", "补发工资", "离职尾款"],
  "兼职": ["PS接单", "设计接单", "问卷收入", "临时工作", "其他兼职"],
  "理财": ["零钱通收益", "银行利息", "基金收益", "其他理财"],
  "礼金": ["红包", "礼物折现", "节日礼金"],
  "饭卡": ["饭卡充值", "学校补助", "饭卡退款"],
  "父母": ["生活费", "学费", "临时支持", "开学费用"],
  "问卷": ["问卷奖励"], "其他": ["其他收入"],
};
const budgetNames = new Set(["餐饮改善", "咖啡", "奶茶", "零食", "游戏", "电影", "网吧", "台球", "会员", "周边", "社交"]);
function buildCategories(groups: Record<string, string[]>, kind: "income" | "expense", offset: number): Category[] {
  const result: Category[] = [];
  Object.entries(groups).forEach(([parent, children], index) => {
    const parentId = `${kind}-${parent}`;
    result.push({ id: parentId, kind, name: parent, icon: kind === "income" ? "CircleArrowDown" : "CircleArrowUp", defaultBudget: false, archived: false, sort: offset + index * 100 });
    children.forEach((name, childIndex) => result.push({ id: `${parentId}-${name}`, kind, name, parentId, icon: "Circle", defaultBudget: budgetNames.has(name), archived: false, sort: offset + index * 100 + childIndex + 1 }));
  });
  return result;
}
export const categories = [...buildCategories(expenseGroups, "expense", 0), ...buildCategories(incomeGroups, "income", 10_000)];

export const salaryPlans: SalaryPlan[] = [{
  id: "salary-summer", name: "暑假工", employer: "餐饮店服务员", startDate: "2026-07-12", endDate: "2026-08-19",
  dailyRateCents: 8000, firstPayDate: "2026-08-15", cutoffDay: 15, payDay: 15, active: true,
}];
export const attendance: Attendance[] = Array.from({ length: 39 }, (_, index) => ({
  id: `attendance-${index + 1}`, planId: "salary-summer", date: addDays("2026-07-12", index), status: "worked", earnedCents: 8000,
}));

export const installmentPlans: InstallmentPlan[] = [{ id: "plan-ps", name: "PS课程分期", totalCents: 430000, accountId: "acc-lqt", categoryId: "expense-学习-PS课程", reminder: true }];
export const installmentItems: InstallmentItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `ps-${index + 1}`, planId: "plan-ps", sequence: index + 1,
  dueDate: toLocalDate(new Date(2026, 6 + index, 15, 12)),
  amountCents: index === 11 ? 36200 : 35800, status: index === 0 ? "paid" : "unpaid",
  actualPaidDate: index === 0 ? "2026-07-15" : undefined, reserved: index === 1, historicalSnapshot: index === 0,
}));

export const reserves: Reserve[] = [
  { id: "reserve-school", name: "大学首月生活费", amountCents: 150000, kind: "living", active: true },
  { id: "reserve-emergency", name: "应急金", amountCents: 50000, kind: "emergency", active: true },
];
export const budget: BudgetSettings = {
  id: "main", weeklyCapCents: 35000, weekStartsOn: 1, rolloverMode: "reset", safetyMode: "30d", customSafetyCents: 235800,
  schoolDate: "2026-09-01", customForecastDate: "2026-09-15",
  budgetPeriod: "weekly",
  categoryLimits: { "餐饮改善": 15000, "咖啡": 4000, "娱乐": 8000, "交通": 3000, "机动资金": 5000 },
};
export const transactions: LedgerTransaction[] = [{
  id: "tx-ps-history", type: "installment_payment", status: "posted", amountCents: 35800, date: "2026-07-15", time: "12:00",
  accountId: "acc-lqt", categoryId: "expense-学习-PS课程", merchant: "PS课程", note: "第一期已支付（余额快照前历史记录）",
  countsTowardBudget: false, rigid: true, reimbursable: false, tags: ["分期", "历史"], attachmentIds: [], linkedId: "ps-1",
  affectsBalance: false, createdAt: "2026-07-15T12:00:00+08:00",
}];
