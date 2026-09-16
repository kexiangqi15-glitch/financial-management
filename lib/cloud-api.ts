const configuredOrigin = (import.meta.env.VITE_CLOUD_API_ORIGIN ?? "").trim().replace(/\/$/, "");

/**
 * Sites uses relative API routes. The GitHub Pages build supplies the existing
 * D1/R2 Worker origin at build time, so no server secret is bundled here.
 */
export const isExternalCloudClient = configuredOrigin.length > 0;

export function cloudApiUrl(path: string) {
  return configuredOrigin ? `${configuredOrigin}${path}` : path;
}

const SYNC_CODE_KEY = "qinglan-external-sync-code";

export function getExternalSyncCode() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(SYNC_CODE_KEY)?.trim() ?? "";
}

export function saveExternalSyncCode(code: string) {
  localStorage.setItem(SYNC_CODE_KEY, code.trim());
}

export function clearExternalSyncCode() {
  localStorage.removeItem(SYNC_CODE_KEY);
}

export function cloudHeaders(headers?: HeadersInit) {
  const result = new Headers(headers);
  if (isExternalCloudClient) {
    const code = getExternalSyncCode();
    if (code) result.set("x-qinglan-sync-code", code);
  }
  return result;
}
