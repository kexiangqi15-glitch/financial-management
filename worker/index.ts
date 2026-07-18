import { CLOUD_SCHEMA_VERSION, type StoredSyncRecord } from "../db/schema";
import { resolveCloudConflict, sanitizeForCloud, type CloudEnvelope } from "../lib/sync/core";
import type { SyncEntity } from "../lib/types";

interface D1Result<T = unknown> { results?: T[]; success?: boolean }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}
interface D1Database { prepare(sql: string): D1PreparedStatement }
interface R2ObjectBody { body: ReadableStream; size: number; httpMetadata?: { contentType?: string } }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}
interface AssetFetcher { fetch(request: Request): Promise<Response> }
interface Env {
  ASSETS: AssetFetcher;
  DB?: D1Database;
  ATTACHMENTS?: R2Bucket;
  QINGLAN_DEV_USER_EMAIL?: string;
}

interface Identity { ownerKey: string; email: string; displayName: string | null }
interface SyncRequestBody { deviceId?: unknown; sinceVersion?: unknown; push?: unknown }

const API_PREFIX = "/api/sync";
const MAX_PUSH_ITEMS = 50;
const MAX_RECORD_JSON_BYTES = 1_000_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const PULL_LIMIT = 1000;
const allowedEntities = new Set<string>([
  "accounts", "categories", "transactions", "salaryPlans", "attendance", "installmentPlans",
  "installmentItems", "reserves", "budgets", "settings", "attachments",
] satisfies SyncEntity[]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      if (!env.DB) throw new HttpError(503, "云数据库尚未绑定，请稍后重试");
      const identity = await authenticatedIdentity(request, env);

      if (url.pathname === `${API_PREFIX}/profile` && request.method === "GET") {
        await touchUser(env.DB, identity, null, request.headers.get("user-agent"));
        const recordCount = await countRecords(env.DB, identity.ownerKey);
        return json({ profile: publicProfile(identity), recordCount });
      }

      if (url.pathname.startsWith(`${API_PREFIX}/attachments/`) && request.method === "GET") {
        if (!env.ATTACHMENTS) throw new HttpError(503, "云附件存储尚未绑定");
        return downloadAttachment(request, env.DB, env.ATTACHMENTS, identity, url);
      }

      if (url.pathname === API_PREFIX && request.method === "POST") {
        return synchronize(request, env, identity);
      }

      throw new HttpError(404, "接口不存在");
    } catch (reason) {
      const status = reason instanceof HttpError ? reason.status : 500;
      const message = reason instanceof Error ? reason.message : "云同步发生未知错误";
      return json({ error: message }, status);
    }
  },
};

async function synchronize(request: Request, env: Env, identity: Identity) {
  const db = env.DB!;
  const body = await readJsonBody(request);
  const deviceId = validateDeviceId(body.deviceId);
  const sinceVersion = validateCursor(body.sinceVersion);
  const candidates = validatePush(body.push);
  await touchUser(db, identity, deviceId, request.headers.get("user-agent"));

  const winners: CloudEnvelope[] = [];
  for (const candidate of candidates) {
    const current = await readRecord(db, identity.ownerKey, candidate.entityType, candidate.recordId);
    if (current) {
      const currentEnvelope = toPublicEnvelope(current);
      const resolution = resolveCloudConflict(candidate, currentEnvelope);
      if (!resolution.accepted) {
        const isIdempotentRetry = candidate.clock === currentEnvelope.clock && candidate.deviceId === currentEnvelope.deviceId;
        if (!isIdempotentRetry) await archiveCandidate(db, identity.ownerKey, candidate, "conflict_loser");
        winners.push(currentEnvelope);
        continue;
      }
    }

    const dataJson = candidate.deleted
      ? null
      : await prepareStoredData(env, identity.ownerKey, candidate);
    const now = new Date().toISOString();
    const sequence = await db.prepare(
      "INSERT INTO sync_sequence (owner_key, created_at) VALUES (?, ?) RETURNING version",
    ).bind(identity.ownerKey, now).first<{ version: number }>();
    if (!sequence?.version) throw new Error("无法分配云端变更版本");

    const accepted = await db.prepare(`
      INSERT INTO sync_records (
        owner_key, entity_type, record_id, data_json, deleted, clock, device_id,
        schema_version, server_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_key, entity_type, record_id) DO UPDATE SET
        data_json = excluded.data_json,
        deleted = excluded.deleted,
        clock = excluded.clock,
        device_id = excluded.device_id,
        schema_version = excluded.schema_version,
        server_version = excluded.server_version,
        updated_at = excluded.updated_at
      WHERE excluded.clock > sync_records.clock
         OR (excluded.clock = sync_records.clock AND excluded.device_id > sync_records.device_id)
      RETURNING *
    `).bind(
      identity.ownerKey,
      candidate.entityType,
      candidate.recordId,
      dataJson,
      candidate.deleted ? 1 : 0,
      candidate.clock,
      candidate.deviceId,
      CLOUD_SCHEMA_VERSION,
      sequence.version,
      now,
    ).first<StoredSyncRecord>();

    if (accepted) {
      winners.push(toPublicEnvelope(accepted));
    } else {
      await archiveCandidate(db, identity.ownerKey, candidate, "concurrent_conflict_loser", dataJson);
      const winner = await readRecord(db, identity.ownerKey, candidate.entityType, candidate.recordId);
      if (winner) winners.push(toPublicEnvelope(winner));
    }
  }

  const pulled = await pullChanges(db, identity.ownerKey, sinceVersion);
  return json({
    profile: publicProfile(identity),
    winners,
    changes: pulled.changes,
    nextVersion: pulled.nextVersion,
    hasMore: pulled.hasMore,
    recordCount: pulled.recordCount,
    serverTime: new Date().toISOString(),
  });
}

async function pullChanges(db: D1Database, ownerKey: string, sinceVersion: number) {
  const result = await db.prepare(`
    SELECT * FROM sync_records
    WHERE owner_key = ? AND server_version > ?
    ORDER BY server_version ASC
    LIMIT ?
  `).bind(ownerKey, sinceVersion, PULL_LIMIT).all<StoredSyncRecord>();
  const rows = result.results ?? [];
  const maximum = await db.prepare(
    "SELECT COALESCE(MAX(server_version), 0) AS version, COUNT(*) AS count FROM sync_records WHERE owner_key = ?",
  ).bind(ownerKey).first<{ version: number; count: number }>();
  const maxVersion = Number(maximum?.version ?? 0);
  const lastRowVersion = rows.length ? Number(rows[rows.length - 1].server_version) : sinceVersion;
  return {
    changes: rows.map(toPublicEnvelope),
    nextVersion: rows.length ? lastRowVersion : Math.max(sinceVersion, maxVersion),
    hasMore: lastRowVersion < maxVersion,
    recordCount: Number(maximum?.count ?? 0),
  };
}

async function prepareStoredData(env: Env, ownerKey: string, candidate: CloudEnvelope) {
  if (candidate.entityType !== "attachments") {
    const sanitized = sanitizeForCloud(candidate.data);
    const serialized = JSON.stringify(sanitized);
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_JSON_BYTES) {
      throw new HttpError(413, "单条记录超过 1MB 云同步限制");
    }
    return serialized;
  }

  if (!env.ATTACHMENTS) throw new HttpError(503, "云附件存储尚未绑定");
  const value = asObject(candidate.data);
  const id = requiredString(value.id, "附件 ID", 512);
  const name = requiredString(value.name, "附件名称", 500);
  const type = requiredString(value.type, "附件类型", 200);
  const size = Number(value.size);
  const blobBase64 = requiredString(value.blobBase64, "附件内容", 8_000_000);
  if (!type.startsWith("image/")) throw new HttpError(400, "附件必须为图片");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "附件必须小于 5MB");
  const bytes = decodeBase64(blobBase64);
  if (bytes.byteLength !== size) throw new HttpError(400, "附件大小校验失败");
  const blobKey = `${ownerKey}/attachments/${encodeURIComponent(id)}/${candidate.clock}-${encodeURIComponent(candidate.deviceId)}`;
  await env.ATTACHMENTS.put(blobKey, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { ownerKey, recordId: id, clock: String(candidate.clock) },
  });
  return JSON.stringify({ id, name, type, size, blobKey });
}

async function downloadAttachment(request: Request, db: D1Database, bucket: R2Bucket, identity: Identity, url: URL) {
  const encodedId = url.pathname.slice(`${API_PREFIX}/attachments/`.length);
  let recordId = "";
  try { recordId = decodeURIComponent(encodedId); } catch { throw new HttpError(400, "附件 ID 无效"); }
  if (!recordId) throw new HttpError(400, "附件 ID 不能为空");
  const expectedClock = Number(url.searchParams.get("clock"));
  const row = await readRecord(db, identity.ownerKey, "attachments", recordId);
  if (!row || row.deleted) throw new HttpError(404, "附件不存在");
  if (Number.isFinite(expectedClock) && expectedClock !== row.clock) throw new HttpError(409, "附件已有新版本，请重新同步");
  const metadata = asObject(parseJson(row.data_json));
  const blobKey = requiredString(metadata.blobKey, "附件云端键", 2000);
  const object = await bucket.get(blobKey);
  if (!object) throw new HttpError(404, "附件文件不存在");
  const type = typeof metadata.type === "string" ? metadata.type : object.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(object.body, {
    headers: {
      "content-type": type,
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function authenticatedIdentity(request: Request, env: Env): Promise<Identity> {
  const url = new URL(request.url);
  const forwarded = request.headers.get("oai-authenticated-user-email");
  const localFallback = (url.hostname === "localhost" || url.hostname === "127.0.0.1") ? env.QINGLAN_DEV_USER_EMAIL : undefined;
  const email = (forwarded || localFallback || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpError(401, "请先使用站点统一账号登录");
  let displayName: string | null = null;
  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  if (encodedName && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { displayName = decodeURIComponent(encodedName).trim() || null; } catch { displayName = null; }
  }
  return { ownerKey: await sha256(email), email, displayName };
}

async function touchUser(db: D1Database, identity: Identity, deviceId: string | null, userAgent: string | null) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO sync_users (owner_key, email, display_name, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner_key) DO UPDATE SET
      email = excluded.email,
      display_name = COALESCE(excluded.display_name, sync_users.display_name),
      last_seen_at = excluded.last_seen_at
  `).bind(identity.ownerKey, identity.email, identity.displayName, now, now).run();
  if (deviceId) {
    await db.prepare(`
      INSERT INTO sync_devices (owner_key, device_id, user_agent, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (owner_key, device_id) DO UPDATE SET
        user_agent = excluded.user_agent,
        last_seen_at = excluded.last_seen_at
    `).bind(identity.ownerKey, deviceId, userAgent, now).run();
  }
}

async function archiveCandidate(db: D1Database, ownerKey: string, candidate: CloudEnvelope, reason: string, preparedDataJson?: string | null) {
  let dataJson = preparedDataJson;
  if (dataJson === undefined) {
    const data = candidate.entityType === "attachments" ? attachmentHistoryMetadata(candidate.data) : sanitizeForCloud(candidate.data);
    dataJson = candidate.deleted ? null : JSON.stringify(data);
  }
  await db.prepare(`
    INSERT INTO sync_history (
      owner_key, entity_type, record_id, data_json, deleted, clock, device_id,
      schema_version, server_version, archived_at, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).bind(
    ownerKey,
    candidate.entityType,
    candidate.recordId,
    dataJson,
    candidate.deleted ? 1 : 0,
    candidate.clock,
    candidate.deviceId,
    CLOUD_SCHEMA_VERSION,
    new Date().toISOString(),
    reason,
  ).run();
}

function attachmentHistoryMetadata(data: unknown) {
  const value = asObject(data);
  return { id: value.id, name: value.name, type: value.type, size: value.size, blobKey: value.blobKey ?? null };
}

async function readRecord(db: D1Database, ownerKey: string, entityType: SyncEntity, recordId: string) {
  return db.prepare(
    "SELECT * FROM sync_records WHERE owner_key = ? AND entity_type = ? AND record_id = ?",
  ).bind(ownerKey, entityType, recordId).first<StoredSyncRecord>();
}

async function countRecords(db: D1Database, ownerKey: string) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM sync_records WHERE owner_key = ?").bind(ownerKey).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function toPublicEnvelope(row: StoredSyncRecord): CloudEnvelope {
  let data = row.deleted ? null : parseJson(row.data_json);
  if (row.entity_type === "attachments" && data) {
    const metadata = asObject(data);
    data = { id: metadata.id, name: metadata.name, type: metadata.type, size: metadata.size, blobVersion: row.clock };
  }
  return {
    entityType: row.entity_type as SyncEntity,
    recordId: row.record_id,
    data,
    deleted: Boolean(row.deleted),
    clock: Number(row.clock),
    deviceId: row.device_id,
    schemaVersion: CLOUD_SCHEMA_VERSION,
    serverVersion: Number(row.server_version),
    updatedAt: row.updated_at,
  };
}

function validatePush(value: unknown): CloudEnvelope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "push 必须是数组");
  if (value.length > MAX_PUSH_ITEMS) throw new HttpError(413, `每次最多同步 ${MAX_PUSH_ITEMS} 条变更`);
  return value.map((entry) => {
    const item = asObject(entry);
    const entityType = requiredString(item.entityType, "实体类型", 100);
    if (!allowedEntities.has(entityType)) throw new HttpError(400, `不支持的实体类型：${entityType}`);
    const recordId = requiredString(item.recordId, "记录 ID", 512);
    const deviceId = validateDeviceId(item.deviceId);
    const clock = Number(item.clock);
    if (!Number.isSafeInteger(clock) || clock <= 0) throw new HttpError(400, "变更时钟无效");
    return {
      entityType: entityType as SyncEntity,
      recordId,
      data: item.deleted ? null : sanitizeForCloud(item.data),
      deleted: Boolean(item.deleted),
      clock,
      deviceId,
      schemaVersion: CLOUD_SCHEMA_VERSION,
    };
  });
}

function validateDeviceId(value: unknown) {
  return requiredString(value, "设备 ID", 200);
}

function validateCursor(value: unknown) {
  if (value === undefined) return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "同步游标无效");
  return cursor;
}

async function readJsonBody(request: Request): Promise<SyncRequestBody> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 10 * 1024 * 1024) throw new HttpError(413, "同步请求过大");
  try { return asObject(await request.json()) as SyncRequestBody; }
  catch { throw new HttpError(400, "请求 JSON 无效"); }
}

function publicProfile(identity: Identity) {
  return { ownerId: identity.ownerKey, email: identity.email, displayName: identity.displayName, photoURL: null };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "对象数据格式无效");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new HttpError(400, `${label}无效`);
  return value;
}

function decodeBase64(value: string) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new HttpError(400, "附件编码无效"); }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
