import type { SyncEntity } from "../types";

export interface VersionStamp {
  clock: number;
  deviceId: string;
}

export interface CloudEnvelope extends VersionStamp {
  entityType: SyncEntity;
  recordId: string;
  data: unknown | null;
  deleted: boolean;
  schemaVersion: 2;
  updatedAt?: unknown;
}

export function compareVersion(left?: VersionStamp, right?: VersionStamp) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.clock !== right.clock) return left.clock > right.clock ? 1 : -1;
  return left.deviceId.localeCompare(right.deviceId);
}

export function remoteShouldApply(remote: VersionStamp, local?: VersionStamp) {
  return compareVersion(remote, local) >= 0;
}

export function recordDocumentId(entityType: SyncEntity, recordId: string) {
  const bytes = new TextEncoder().encode(recordId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${entityType}--${encoded}`;
}

export function splitBase64(value: string, size = 600_000) {
  if (!Number.isInteger(size) || size <= 0) throw new Error("分块大小必须为正整数");
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.slice(offset, offset + size));
  return chunks;
}

export function sanitizeForFirestore(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeForFirestore);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = sanitizeForFirestore(child);
    return result;
  }
  return String(value);
}

export function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
