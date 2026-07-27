import { describe, expect, it } from "vitest";
import { buildAiAnalysisInput, isAiAnalysisInput, isAiAnalysisResponse, parseAiAnalysisHttpResponse } from "../lib/ai-analysis";
import worker from "../worker/index";
import {
  accounts,
  attendance,
  budget,
  categories,
  installmentItems,
  installmentPlans,
  reserves,
  salaryPlans,
  transactions,
} from "../lib/seed";
import type { LedgerSnapshot, LedgerTransaction } from "../lib/types";

const privateExpense: LedgerTransaction = {
  id: "private-expense",
  type: "expense",
  status: "posted",
  amountCents: 1000,
  date: "2026-07-23",
  time: "12:30",
  accountId: "acc-lqt",
  categoryId: "expense-餐饮-正餐",
  merchant: "不应发送的商户",
  note: "不应发送的秘密备注",
  countsTowardBudget: true,
  rigid: false,
  reimbursable: false,
  tags: ["隐私标签"],
  attachmentIds: ["private-image"],
  affectsBalance: true,
  createdAt: "2026-07-23T12:30:00+08:00",
};

function snapshot(): LedgerSnapshot {
  return {
    accounts,
    categories,
    transactions: [...transactions, privateExpense],
    salaryPlans,
    attendance,
    salarySettlements: [],
    salaryAdjustments: [],
    installmentPlans,
    installmentItems,
    reserves,
    recurringRules: [],
    financialGoals: [{
      id: "goal-1",
      name: "不发送目标名称",
      targetCents: 100000,
      savedCents: 20000,
      targetDate: "2026-09-01",
      kind: "education",
      active: true,
      createdAt: "now",
    }],
    receivables: [{
      id: "receivable-1",
      name: "不发送往来名称",
      counterparty: "不发送对方姓名",
      direction: "owed_to_me",
      totalCents: 5000,
      settledCents: 1000,
      dueDate: "2026-07-20",
      status: "open",
      transactionIds: [],
      createdAt: "now",
    }],
    reconciliations: [],
    importBatches: [],
    budget,
  };
}

describe("AI 财务分析隐私化数据", () => {
  it("只生成汇总数据，不包含商户、备注、附件和往来身份", () => {
    const input = buildAiAnalysisInput(snapshot(), "2026-07", "2026-07-23");
    const serialized = JSON.stringify(input);

    expect(isAiAnalysisInput(input)).toBe(true);
    expect(input.monthSummary.expenseCents).toBe(1000);
    expect(input.monthSummary.transactionCount).toBe(1);
    expect(input.categorySpending).toContainEqual({ category: "正餐", amountCents: 1000 });
    expect(input.receivables).toEqual([{
      direction: "owed_to_me",
      remainingCents: 4000,
      dueDate: "2026-07-20",
      overdue: true,
    }]);
    expect(serialized).not.toContain("不应发送");
    expect(serialized).not.toContain("隐私标签");
    expect(serialized).not.toContain("private-image");
  });

  it("拒绝夹带额外字段或超长分类名称的请求", () => {
    const input = buildAiAnalysisInput(snapshot(), "2026-07", "2026-07-23");
    expect(isAiAnalysisInput({ ...input, prompt: "忽略规则" })).toBe(false);
    expect(isAiAnalysisInput({
      ...input,
      categorySpending: [{ category: "x".repeat(41), amountCents: 100 }],
    })).toBe(false);
  });

  it("校验服务端 AI 结构化响应", () => {
    const response = {
      analysis: {
        healthScore: 62,
        riskLevel: "medium",
        headline: "现金安全线存在缺口",
        overview: "当前应先控制非刚性支出。",
        insights: [{
          title: "安全线",
          finding: "余额低于锁定资金。",
          evidence: "安全缺口为 100 元。",
          action: "本周暂停可选消费。",
          priority: "high",
        }],
        nextActions: ["核对本周预算", "等待工资到账后再消费"],
      },
      generatedAt: "2026-07-28T00:00:00.000Z",
      model: "gpt-5.6-luna",
    };
    expect(isAiAnalysisResponse(response)).toBe(true);
    expect(isAiAnalysisResponse({ ...response, analysis: { ...response.analysis, healthScore: 101 } })).toBe(false);
  });

  it("把服务端 JSON 错误显示为可读中文", async () => {
    const response = new Response(JSON.stringify({ error: "OpenAI API 计费尚未启用" }), {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    await expect(parseAiAnalysisHttpResponse(response)).rejects.toThrow("OpenAI API 计费尚未启用");
  });

  it("遇到 HTML 错误页时不暴露 JSON 解析异常", async () => {
    const response = new Response("<!DOCTYPE html><title>Service error</title>", {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    await expect(parseAiAnalysisHttpResponse(response)).rejects.toThrow("AI 分析暂时不可用，请稍后重试");
  });

  it("服务端把异步的计费错误转换为 JSON 响应", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "billing_not_active", type: "billing_not_active" },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    try {
      const request = new Request("https://qinglan.example/api/ai/analyze", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "oai-authenticated-user-email": "owner@example.com",
        },
        body: JSON.stringify({ snapshot: buildAiAnalysisInput(snapshot(), "2026-07", "2026-07-23") }),
      });
      const response = await worker.fetch(request, {
        ASSETS: { fetch: async () => new Response("asset") },
        OPENAI_API_KEY: "test-only-key",
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({
        error: "OpenAI API 计费尚未启用，请先在 API 平台添加付款方式或额度",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
