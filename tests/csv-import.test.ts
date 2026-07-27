import { describe, expect, it } from "vitest";
import { previewTransactionCsv } from "../lib/csv-import";
import type { LedgerTransaction } from "../lib/types";

const existing: LedgerTransaction = {
  id: "old",
  type: "expense",
  status: "posted",
  amountCents: 1250,
  date: "2026-07-26",
  time: "12:30",
  accountId: "a",
  merchant: "早餐店",
  countsTowardBudget: true,
  rigid: false,
  reimbursable: false,
  tags: ["账单导入", "import-order:ORDER-1"],
  attachmentIds: [],
  affectsBalance: true,
  createdAt: "now",
};

describe("微信支付宝银行卡CSV导入", () => {
  it("识别收支、金额和引号字段，并跳过订单号重复记录", () => {
    const csv = [
      "微信支付账单",
      "交易时间,交易类型,交易对方,商品说明,金额(元),支付状态,交易单号",
      '2026-07-26 12:30,支出,早餐店,"豆浆,油条",12.50,支付成功,ORDER-1',
      "2026-07-27 09:00,收入,同学,还款,20.00,已收款,ORDER-2",
    ].join("\n");
    const result = previewTransactionCsv(csv, "微信支付账单.csv", [existing]);
    expect(result.source).toBe("wechat");
    expect(result.duplicateCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      type: "income",
      amountCents: 2000,
      date: "2026-07-27",
      merchant: "同学",
      orderId: "ORDER-2",
    });
  });

  it("忽略失败或缺少有效日期金额的明细", () => {
    const csv = [
      "交易时间,收/支,交易对方,金额,当前状态",
      "2026-07-26 10:00,支出,商店,9.90,交易关闭",
      "无日期,支出,商店,10.00,支付成功",
    ].join("\n");
    const result = previewTransactionCsv(csv, "bank.csv", []);
    expect(result.rows).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
  });
});
