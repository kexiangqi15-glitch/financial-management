import { afterEach, describe, expect, it, vi } from "vitest";

describe("旧站登录与 Pages 同步凭证", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it("旧站必须发送同源登录 Cookie，不能因 Pages 改造丢失凭证", async () => {
    vi.stubEnv("VITE_CLOUD_API_ORIGIN", "");
    vi.resetModules();
    const api = await import("../lib/cloud-api");
    expect(api.cloudCredentials()).toBe("same-origin");
    expect(api.cloudApiUrl("/api/sync")).toBe("/api/sync");
    expect(api.cloudHeaders().has("x-qinglan-sync-code")).toBe(false);
  });

  it("Pages 只用同步码，不依赖跨站 Cookie；保存时统一小写", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubEnv("VITE_CLOUD_API_ORIGIN", "https://cloud.example/");
    vi.resetModules();
    const api = await import("../lib/cloud-api");
    api.saveExternalSyncCode(` ${"AB".repeat(24)} `);
    expect(api.cloudCredentials()).toBe("omit");
    expect(api.cloudApiUrl("/api/sync")).toBe("https://cloud.example/api/sync");
    expect(api.cloudHeaders({ "content-type": "application/json" }).get("x-qinglan-sync-code")).toBe("ab".repeat(24));
    expect(api.cloudHeaders().get("oai-authenticated-user-email")).toBeNull();
    api.clearExternalSyncCode();
    expect(api.cloudHeaders().has("x-qinglan-sync-code")).toBe(false);
  });
});
