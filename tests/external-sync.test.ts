import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index";

// Execute the actual D1 migrations and SQL against SQLite, not canned route responses.
let sqlite: DatabaseSync;
function database() {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = sqlite.prepare(sql);
      return {
        bind(...args: unknown[]) { values = args as SQLInputValue[]; return this; },
        async first<T>() { return (statement.get(...values) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...values) as T[], success: true }; },
        async run() { statement.run(...values); return { success: true }; },
      };
    },
  };
}
const code = "ab".repeat(24); // Synthetic test credential only.
const pagesOrigin = "https://kexiangqi15-glitch.github.io";
function request(path: string, options: RequestInit = {}) {
  return worker.fetch(new Request(`https://qinglan.example${path}`, options), {
    ASSETS: { fetch: async () => new Response("asset") }, DB: database(),
  });
}
function createLink(email = "original@example.com", value = code) {
  return request("/api/sync/external-link", {
    method: "POST", headers: { "oai-authenticated-user-email": email, "content-type": "application/json" },
    body: JSON.stringify({ code: value }),
  });
}
function sync(headers: HeadersInit, push: unknown[] = [], sinceVersion = 0) {
  return request("/api/sync", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "test-device", sinceVersion, push }),
  });
}

describe("原账号到 Pages 的真实数据库连接", () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    for (const name of ["0000_d1_cloud_sync.sql", "0001_external_sync_links.sql"]) {
      sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
    }
  });
  afterEach(() => sqlite.close());

  it("无平台身份不能生成同步码，失效码返回 JSON 401", async () => {
    const denied = await request("/api/sync/external-link", { method: "POST", body: JSON.stringify({ code }) });
    expect(denied.status).toBe(401);
    const invalid = await sync({ "x-qinglan-sync-code": code, origin: pagesOrigin });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("access-control-allow-origin")).toBe(pagesOrigin);
    await expect(invalid.json()).resolves.toMatchObject({ error: "同步码无效或已失效" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_records").get()?.n).toBe(0);
  });

  it("生成48位码连接原账本，增量修改双向可见且保存原账号资料", async () => {
    const originalHeaders = { "oai-authenticated-user-email": "original@example.com" };
    const initial = await sync(originalHeaders, [{
      entityType: "accounts", recordId: "account-1", data: { id: "account-1", openingBalanceCents: 10000 },
      deleted: false, clock: 10, deviceId: "desktop", schemaVersion: 3,
    }]);
    expect(initial.status).toBe(200);
    const original = await initial.json() as { profile: { ownerId: string }; nextVersion: number };
    expect((await createLink()).status).toBe(200);
    const externalHeaders = { "x-qinglan-sync-code": code.toUpperCase(), origin: pagesOrigin };
    const pulled = await sync(externalHeaders);
    expect(pulled.status).toBe(200);
    const fromPages = await pulled.json() as { profile: { ownerId: string }; recordCount: number; changes: unknown[] };
    expect(fromPages.profile.ownerId).toBe(original.profile.ownerId);
    expect(fromPages.recordCount).toBe(1);
    expect(fromPages.changes).toHaveLength(1);
    const updated = await sync(externalHeaders, [{
      entityType: "accounts", recordId: "account-1", data: { id: "account-1", openingBalanceCents: 9500 },
      deleted: false, clock: 20, deviceId: "phone", schemaVersion: 3,
    }], original.nextVersion);
    expect(updated.status).toBe(200);
    const desktopPull = await (await sync(originalHeaders, [], original.nextVersion)).json() as { changes: Array<{ data: { openingBalanceCents: number } }> };
    expect(desktopPull.changes[0].data.openingBalanceCents).toBe(9500);
    expect(sqlite.prepare("SELECT email FROM sync_users").get()?.email).toBe("original@example.com");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_history").get()?.n).toBe(1);
    const link = sqlite.prepare("SELECT code_hash FROM sync_external_links").get();
    expect(link?.code_hash).not.toBe(code);
  });

  it("其他账号不能抢占已有同步码，也不能查询原账号的数据", async () => {
    expect((await createLink()).status).toBe(200);
    expect((await createLink("other@example.com")).status).toBe(409);
    const other = await (await sync({ "oai-authenticated-user-email": "other@example.com" })).json() as { recordCount: number };
    expect(other.recordCount).toBe(0);
    const profiles = sqlite.prepare("SELECT email FROM sync_users ORDER BY email").all();
    expect(profiles).toHaveLength(2);
    expect((await createLink()).status).toBe(200); // Same-owner retry is idempotent.
  });
});
