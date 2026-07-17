import { describe, expect, it } from "vitest";
import { compareVersion, recordDocumentId, remoteShouldApply, sanitizeForFirestore, splitBase64 } from "../lib/sync/core";

describe("跨设备同步冲突与序列化", () => {
  it("Last Write Wins 优先更晚时钟并用设备 ID 稳定打破平局", () => {
    expect(compareVersion({ clock: 20, deviceId: "phone" }, { clock: 10, deviceId: "pc" })).toBe(1);
    expect(compareVersion({ clock: 20, deviceId: "phone" }, { clock: 20, deviceId: "pc" })).toBeGreaterThan(0);
    expect(remoteShouldApply({ clock: 9, deviceId: "phone" }, { clock: 10, deviceId: "pc" })).toBe(false);
  });

  it("中文记录 ID 可转换为无斜杠的稳定 Firestore 文档 ID", () => {
    const id = recordDocumentId("categories", "餐饮/咖啡-早餐");
    expect(id).toBe(recordDocumentId("categories", "餐饮/咖啡-早餐"));
    expect(id).not.toContain("/");
  });

  it("大附件可按文档上限分块并完整重组", () => {
    const value = "青蓝".repeat(800_000);
    const chunks = splitBase64(value, 600_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(value);
    expect(chunks.every((chunk) => chunk.length <= 600_000)).toBe(true);
  });

  it("Firestore 数据清洗移除 undefined 且保留整数金额", () => {
    expect(sanitizeForFirestore({ amountCents: 135305, note: undefined, tags: ["同步"] })).toEqual({ amountCents: 135305, tags: ["同步"] });
  });
});
