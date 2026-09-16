import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initializeDatabase } from "../lib/db";
import { D1SyncEngine } from "../lib/sync/engine";
import { compareVersion, resolveCloudConflict, type CloudEnvelope } from "../lib/sync/core";

describe("D1 跨设备增量同步", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("Last Write Wins 会返回唯一赢家并保留被覆盖版本", () => {
    const desktop = { clock: 20, deviceId: "desktop" };
    const phone = { clock: 10, deviceId: "phone" };
    expect(resolveCloudConflict(desktop, phone)).toEqual({ accepted: true, winner: desktop, history: phone });
    expect(resolveCloudConflict(phone, desktop)).toEqual({ accepted: false, winner: desktop, history: phone });
  });

  it("手机先上传默认数据时，电脑改过的同 ID 余额仍会迁移并成为云端赢家", async () => {
    await initializeDatabase();
    await db.accounts.update("acc-lqt", { openingBalanceCents: 135305 });
    const account = await db.accounts.get("acc-lqt");
    if (!account) throw new Error("测试账户缺失");

    let serverVersion = 1;
    let cloud: CloudEnvelope = {
      entityType: "accounts",
      recordId: "acc-lqt",
      data: { ...account, openingBalanceCents: 135855 },
      deleted: false,
      clock: 10,
      deviceId: "phone",
      schemaVersion: 3,
      serverVersion,
    };

    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { sinceVersion: number; push: CloudEnvelope[] };
      const winners: CloudEnvelope[] = [];
      for (const candidate of request.push) {
        if (compareVersion(candidate, cloud) > 0) cloud = { ...candidate, serverVersion: ++serverVersion };
        winners.push(cloud);
      }
      const changes = Number(cloud.serverVersion) > request.sinceVersion ? [cloud] : [];
      return Response.json({
        profile: { ownerId: "owner-test", email: "owner@example.com", displayName: "测试用户", photoURL: null },
        winners,
        changes,
        nextVersion: serverVersion,
        hasMore: false,
        recordCount: 1,
        serverTime: new Date().toISOString(),
      });
    }) as unknown as typeof fetch;

    const engine = new D1SyncEngine({ deviceId: "desktop", fetcher, pollIntervalMs: 0, onState: () => undefined });
    await (engine as unknown as { performBootstrap(): Promise<void> }).performBootstrap();

    expect((await db.accounts.get("acc-lqt"))?.openingBalanceCents).toBe(135305);
    expect((cloud.data as { openingBalanceCents: number }).openingBalanceCents).toBe(135305);
    expect(await db.syncQueue.count()).toBe(0);
    expect(vi.mocked(fetcher).mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(true);
  });
});
