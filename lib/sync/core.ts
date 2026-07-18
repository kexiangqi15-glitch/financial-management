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
  serverVersion?: number;
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

export function resolveCloudConflict<T extends VersionStamp>(candidate: T, current?: T) {
  if (!current) return { accepted: true, winner: candidate, history: undefined } as const;
  const accepted = compareVersion(candidate, current) > 0;
  return {
    accepted,
    winner: accepted ? candidate : current,
    history: accepted ? current : candidate,
  } as const;
}

export function cloudRecordKey(entityType: SyncEntity, recordId: string) {
  const bytes = new TextEncoder().encode(recordId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${entityType}--${encoded}`;
}

export function sanitizeForCloud(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeForCloud);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = sanitizeForCloud(child);
    return result;
  }
  return String(value);
}

export function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
