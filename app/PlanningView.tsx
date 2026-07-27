"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Check, CircleDollarSign, Pause, PiggyBank, Play, Plus, Users } from "lucide-react";
import { db, queueLocalChange } from "@/lib/db";
import { nextRecurringDate, toLocalDate } from "@/lib/calculations";
import type { LedgerSnapshot, LocalDate, Receivable, TransactionType } from "@/lib/types";
import { asCents, formatMoney, uid } from "@/lib/types";

const TODAY = toLocalDate(new Date());

export function PlanningView({
  data,
  onRefresh,
  setToast,
}: {
  data: LedgerSnapshot;
  onRefresh: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [ruleName, setRuleName] = useState("");
  const [ruleAmount, setRuleAmount] = useState("");
  const [ruleDate, setRuleDate] = useState<LocalDate>(TODAY);
  const [ruleType, setRuleType] = useState<"expense" | "income">("expense");
  const [ruleFrequency, setRuleFrequency] = useState<"weekly" | "monthly" | "yearly">("monthly");
  const [goalName, setGoalName] = useState("");
  const [goalAmount, setGoalAmount] = useState("");
  const [goalDate, setGoalDate] = useState<LocalDate>(data.budget.schoolDate);
  const [debtName, setDebtName] = useState("");
  const [debtCounterparty, setDebtCounterparty] = useState("");
  const [debtAmount, setDebtAmount] = useState("");
  const [debtDueDate, setDebtDueDate] = useState<LocalDate>(data.budget.schoolDate);
  const [debtDirection, setDebtDirection] = useState<Receivable["direction"]>("owed_to_me");

  const activeGoals = useMemo(() => data.financialGoals.filter((goal) => goal.active), [data.financialGoals]);

  const addRule = async () => {
    const amountCents = asCents(Number(ruleAmount));
    const account = data.accounts.find((item) => !item.hidden);
    const category = data.categories.find((item) => item.kind === ruleType && item.parentId && !item.archived);
    if (!ruleName.trim() || amountCents <= 0 || !account || !category) {
      setToast("请填写名称和有效金额");
      return;
    }
    const id = uid("recurring");
    await db.recurringRules.add({
      id,
      name: ruleName.trim(),
      type: ruleType,
      amountCents,
      accountId: account.id,
      categoryId: category.id,
      frequency: ruleFrequency,
      interval: 1,
      nextDate: ruleDate,
      countsTowardBudget: ruleType === "expense",
      rigid: ruleType === "expense",
      active: true,
      createdAt: new Date().toISOString(),
    });
    await queueLocalChange("recurringRules", id);
    setRuleName("");
    setRuleAmount("");
    await onRefresh();
    setToast("周期账单已添加，只进入预测");
  };

  const postRule = async (id: string) => {
    const rule = data.recurringRules.find((item) => item.id === id);
    if (!rule) return;
    const transactionId = uid("tx");
    await db.transaction("rw", [db.transactions, db.recurringRules], async () => {
      await db.transactions.add({
        id: transactionId,
        type: rule.type,
        status: "posted",
        amountCents: rule.amountCents,
        date: TODAY,
        time: new Date().toTimeString().slice(0, 5),
        accountId: rule.accountId,
        categoryId: rule.categoryId,
        merchant: rule.name,
        note: "由周期账单确认执行",
        countsTowardBudget: rule.countsTowardBudget,
        rigid: rule.rigid,
        reimbursable: false,
        tags: ["周期账单"],
        attachmentIds: [],
        recurringRuleId: rule.id,
        affectsBalance: true,
        createdAt: new Date().toISOString(),
      });
      await db.recurringRules.update(rule.id, { nextDate: nextRecurringDate(rule) });
    });
    await queueLocalChange("transactions", transactionId);
    await queueLocalChange("recurringRules", rule.id);
    await onRefresh();
    setToast("已生成真实流水并推进下次日期");
  };

  const addGoal = async () => {
    const targetCents = asCents(Number(goalAmount));
    if (!goalName.trim() || targetCents <= 0) {
      setToast("请填写目标名称和金额");
      return;
    }
    const id = uid("goal");
    await db.financialGoals.add({
      id,
      name: goalName.trim(),
      targetCents,
      savedCents: 0,
      targetDate: goalDate,
      kind: "other",
      active: true,
      createdAt: new Date().toISOString(),
    });
    await queueLocalChange("financialGoals", id);
    setGoalName("");
    setGoalAmount("");
    await onRefresh();
    setToast("储蓄目标已创建");
  };

  const updateGoal = async (id: string, currentCents: number, targetCents: number) => {
    const value = window.prompt("输入当前已经为这个目标锁定的金额（元）", String(currentCents / 100));
    if (value === null) return;
    const savedCents = Math.min(targetCents, Math.max(0, asCents(Number(value))));
    if (!Number.isFinite(savedCents)) {
      setToast("金额格式无效");
      return;
    }
    await db.financialGoals.update(id, { savedCents });
    await queueLocalChange("financialGoals", id);
    await onRefresh();
    setToast("目标进度已更新，资金已计入安全线");
  };

  const addReceivable = async () => {
    const totalCents = asCents(Number(debtAmount));
    if (!debtName.trim() || !debtCounterparty.trim() || totalCents <= 0) {
      setToast("请完整填写往来信息");
      return;
    }
    const id = uid("receivable");
    await db.receivables.add({
      id,
      name: debtName.trim(),
      counterparty: debtCounterparty.trim(),
      direction: debtDirection,
      totalCents,
      settledCents: 0,
      dueDate: debtDueDate,
      status: "open",
      transactionIds: [],
      createdAt: new Date().toISOString(),
    });
    await queueLocalChange("receivables", id);
    setDebtName("");
    setDebtCounterparty("");
    setDebtAmount("");
    await onRefresh();
    setToast("应收/借款记录已添加");
  };

  const settleReceivable = async (item: Receivable) => {
    const remainingCents = item.totalCents - item.settledCents;
    const value = window.prompt("本次实际结算金额（元）", String(remainingCents / 100));
    if (value === null) return;
    const amountCents = Math.min(remainingCents, asCents(Number(value)));
    const account = data.accounts.find((accountItem) => !accountItem.hidden);
    if (!account || !Number.isFinite(amountCents) || amountCents <= 0) {
      setToast("结算金额无效");
      return;
    }
    const type: TransactionType = item.direction === "owed_to_me"
      ? "loan_repayment"
      : item.direction === "reimbursement" ? "refund" : "expense";
    const categoryKind = type === "expense" ? "expense" : "income";
    const category = data.categories.find((categoryItem) => categoryItem.kind === categoryKind && categoryItem.parentId);
    const transactionId = uid("tx");
    const settledCents = item.settledCents + amountCents;
    await db.transaction("rw", [db.transactions, db.receivables], async () => {
      await db.transactions.add({
        id: transactionId,
        type,
        status: "posted",
        amountCents,
        date: TODAY,
        time: new Date().toTimeString().slice(0, 5),
        accountId: account.id,
        categoryId: category?.id,
        merchant: item.counterparty,
        note: `${item.name} · 往来结算`,
        countsTowardBudget: false,
        rigid: item.direction === "i_owe",
        reimbursable: false,
        tags: ["应收往来"],
        attachmentIds: [],
        receivableId: item.id,
        affectsBalance: true,
        createdAt: new Date().toISOString(),
      });
      await db.receivables.update(item.id, {
        settledCents,
        status: settledCents >= item.totalCents ? "settled" : "open",
        transactionIds: [...item.transactionIds, transactionId],
      });
    });
    await queueLocalChange("transactions", transactionId);
    await queueLocalChange("receivables", item.id);
    await onRefresh();
    setToast(settledCents >= item.totalCents ? "往来已结清" : "已记录部分结算");
  };

  return <div className="page-stack planning-page">
    <section className="planning-summary">
      <div><CalendarClock /><span>周期计划</span><strong>{data.recurringRules.filter((item) => item.active).length}</strong></div>
      <div><PiggyBank /><span>目标已锁定</span><strong>{formatMoney(activeGoals.reduce((sum, goal) => sum + goal.savedCents, 0))}</strong></div>
      <div><Users /><span>未结往来</span><strong>{data.receivables.filter((item) => item.status === "open").length}</strong></div>
    </section>

    <section className="planning-grid">
      <article className="card">
        <div className="card-head"><h2>周期账单</h2></div>
        <div className="compact-form">
          <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="如：手机话费" />
          <input inputMode="decimal" value={ruleAmount} onChange={(event) => setRuleAmount(event.target.value)} placeholder="金额" />
          <select value={ruleType} onChange={(event) => setRuleType(event.target.value as typeof ruleType)}><option value="expense">支出</option><option value="income">收入</option></select>
          <select value={ruleFrequency} onChange={(event) => setRuleFrequency(event.target.value as typeof ruleFrequency)}><option value="weekly">每周</option><option value="monthly">每月</option><option value="yearly">每年</option></select>
          <input type="date" value={ruleDate} onChange={(event) => setRuleDate(event.target.value as LocalDate)} />
          <button className="primary" onClick={addRule}><Plus />添加</button>
        </div>
        <div className="planning-list">{data.recurringRules.map((rule) => <div key={rule.id}>
          <span><strong>{rule.name}</strong><small>下次 {rule.nextDate} · {frequencyLabel(rule.frequency)}</small></span>
          <b>{formatMoney(rule.amountCents)}</b>
          <button onClick={() => postRule(rule.id)} disabled={!rule.active}><Check />执行</button>
          <button className="icon-only" aria-label={rule.active ? "暂停" : "启用"} onClick={async () => {
            await db.recurringRules.update(rule.id, { active: !rule.active });
            await queueLocalChange("recurringRules", rule.id);
            await onRefresh();
          }}>{rule.active ? <Pause /> : <Play />}</button>
        </div>)}</div>
      </article>

      <article className="card">
        <div className="card-head"><h2>储蓄目标与资金罐</h2></div>
        <div className="compact-form">
          <input value={goalName} onChange={(event) => setGoalName(event.target.value)} placeholder="如：开学生活费" />
          <input inputMode="decimal" value={goalAmount} onChange={(event) => setGoalAmount(event.target.value)} placeholder="目标金额" />
          <input type="date" value={goalDate} onChange={(event) => setGoalDate(event.target.value as LocalDate)} />
          <button className="primary" onClick={addGoal}><Plus />添加</button>
        </div>
        <div className="goal-list">{data.financialGoals.map((goal) => {
          const percent = goal.targetCents ? Math.min(100, Math.round(goal.savedCents / goal.targetCents * 100)) : 0;
          return <button key={goal.id} onClick={() => updateGoal(goal.id, goal.savedCents, goal.targetCents)}>
            <div><strong>{goal.name}</strong><span>{formatMoney(goal.savedCents)} / {formatMoney(goal.targetCents)}</span></div>
            <div className="progress thin"><i style={{ width: `${percent}%` }} /></div>
            <small>{percent}% · 目标 {goal.targetDate}</small>
          </button>;
        })}</div>
      </article>
    </section>

    <article className="card">
      <div className="card-head"><h2>应收、借款与报销</h2></div>
      <div className="compact-form wide-form">
        <input value={debtName} onChange={(event) => setDebtName(event.target.value)} placeholder="事项" />
        <input value={debtCounterparty} onChange={(event) => setDebtCounterparty(event.target.value)} placeholder="对方" />
        <input inputMode="decimal" value={debtAmount} onChange={(event) => setDebtAmount(event.target.value)} placeholder="总金额" />
        <select value={debtDirection} onChange={(event) => setDebtDirection(event.target.value as Receivable["direction"])}><option value="owed_to_me">别人欠我</option><option value="i_owe">我欠别人</option><option value="reimbursement">等待报销</option></select>
        <input type="date" value={debtDueDate} onChange={(event) => setDebtDueDate(event.target.value as LocalDate)} />
        <button className="primary" onClick={addReceivable}><Plus />添加</button>
      </div>
      <div className="receivable-list">{data.receivables.map((item) => {
        const remaining = Math.max(0, item.totalCents - item.settledCents);
        return <div key={item.id} className={item.status}>
          <CircleDollarSign />
          <span><strong>{item.name}</strong><small>{directionLabel(item.direction)} · {item.counterparty} · 到期 {item.dueDate}</small></span>
          <b>{item.status === "settled" ? "已结清" : formatMoney(remaining)}</b>
          {item.status === "open" && <button onClick={() => settleReceivable(item)}>记录结算</button>}
        </div>;
      })}</div>
    </article>
  </div>;
}

function frequencyLabel(value: "weekly" | "monthly" | "yearly") {
  return { weekly: "每周", monthly: "每月", yearly: "每年" }[value];
}

function directionLabel(value: Receivable["direction"]) {
  return { owed_to_me: "别人欠我", i_owe: "我欠别人", reimbursement: "等待报销" }[value];
}
