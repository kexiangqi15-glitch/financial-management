import type { LedgerTransaction, LocalDate, TransactionType } from "./types";
import { asCents } from "./types";

export interface ImportedTransactionDraft {
  type: Extract<TransactionType, "expense" | "income" | "refund">;
  amountCents: number;
  date: LocalDate;
  time: string;
  merchant: string;
  note: string;
  orderId?: string;
  fingerprint: string;
}

export function previewTransactionCsv(
  text: string,
  fileName: string,
  existing: LedgerTransaction[],
) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => /(交易时间|创建时间|日期|时间)/.test(cell))
    && row.some((cell) => /(金额|交易金额|金额\(元\))/.test(cell))
  );
  if (headerIndex < 0) throw new Error("没有识别到日期和金额列，请使用微信、支付宝或银行卡 CSV 明细");
  const headers = rows[headerIndex].map(normalizeHeader);
  const indexOf = (...patterns: RegExp[]) => headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  const dateIndex = indexOf(/交易时间/, /创建时间/, /^时间$/, /^日期$/);
  const amountIndex = indexOf(/金额/);
  const directionIndex = indexOf(/收支/, /收\/支/, /类型/);
  const merchantIndex = indexOf(/交易对方/, /对方/, /商户/, /商家/, /商品/);
  const noteIndex = indexOf(/商品说明/, /商品/, /备注/, /说明/);
  const orderIndex = indexOf(/订单号/, /交易单号/, /流水号/, /商户单号/);
  const statusIndex = indexOf(/状态/);
  const existingFingerprints = new Set(existing.map(transactionFingerprint));
  const existingOrders = new Set(existing.flatMap((transaction) => transaction.tags.filter((tag) => tag.startsWith("import-order:")).map((tag) => tag.slice(13))));
  const drafts: ImportedTransactionDraft[] = [];
  let duplicateCount = 0;
  let skippedCount = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    const rawDate = row[dateIndex] ?? "";
    const dateMatch = rawDate.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    const amount = Number((row[amountIndex] ?? "").replace(/[¥￥,\s]/g, "").replace(/[^\d.-]/g, ""));
    if (!dateMatch || !Number.isFinite(amount) || amount === 0) {
      skippedCount += 1;
      continue;
    }
    const status = statusIndex >= 0 ? row[statusIndex] ?? "" : "";
    if (/(失败|关闭|取消)/.test(status)) {
      skippedCount += 1;
      continue;
    }
    const direction = directionIndex >= 0 ? row[directionIndex] ?? "" : "";
    const type: ImportedTransactionDraft["type"] = /退款/.test(direction + status)
      ? "refund"
      : /(收入|收款|转入|贷)/.test(direction) ? "income" : "expense";
    const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` as LocalDate;
    const time = rawDate.match(/\b(\d{1,2}:\d{2})/)?.[1]?.padStart(5, "0") ?? "12:00";
    const merchant = (merchantIndex >= 0 ? row[merchantIndex] : "")?.trim() || "账单导入";
    const note = (noteIndex >= 0 ? row[noteIndex] : "")?.trim() || `来自 ${sourceLabel(detectSource(fileName))}`;
    const orderId = (orderIndex >= 0 ? row[orderIndex] : "")?.trim() || undefined;
    const amountCents = Math.abs(asCents(amount));
    const fingerprint = `${date}|${amountCents}|${merchant}|${type}`;
    if (existingFingerprints.has(fingerprint) || orderId && existingOrders.has(orderId)) {
      duplicateCount += 1;
      continue;
    }
    existingFingerprints.add(fingerprint);
    if (orderId) existingOrders.add(orderId);
    drafts.push({ type, amountCents, date, time, merchant, note, orderId, fingerprint });
  }

  return {
    source: detectSource(fileName),
    sourceLabel: sourceLabel(detectSource(fileName)),
    rows: drafts,
    duplicateCount,
    skippedCount,
  };
}

export function transactionFingerprint(transaction: LedgerTransaction) {
  return `${transaction.date}|${transaction.amountCents}|${transaction.merchant ?? ""}|${transaction.type}`;
}

function detectSource(fileName: string): "wechat" | "alipay" | "bank" | "generic" {
  const normalized = fileName.toLowerCase();
  if (/微信|wechat|wx/.test(normalized)) return "wechat";
  if (/支付宝|alipay/.test(normalized)) return "alipay";
  if (/银行|bank|card/.test(normalized)) return "bank";
  return "generic";
}

function sourceLabel(source: "wechat" | "alipay" | "bank" | "generic") {
  return { wechat: "微信账单", alipay: "支付宝账单", bank: "银行卡账单", generic: "CSV账单" }[source];
}

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, "").replaceAll('"', "");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
