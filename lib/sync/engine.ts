import {
  db,
  deleteRemoteRecord,
  getLocalRecord,
  getRecordStamp,
  listLegacyCustomizations,
  putRemoteRecord,
  queueAllLocalData,
  queueLocalChange,
  queuePristineSeedData,
} from "../db";
import type { AttachmentRecord, SyncQueueItem } from "../types";
import {
  compareVersion,
  errorMessage,
  sanitizeForCloud,
  type CloudEnvelope,
} from "./core";

export type SyncStatus = "offline" | "syncing" | "success" | "error";

export interface SyncEngineState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt?: string;
  error?: string;
}

export interface CloudProfile {
  ownerId: string;
  email: string;
  displayName: string | null;
  photoURL: null;
}

interface SyncResponse {
  profile: CloudProfile;
  winners: CloudEnvelope[];
  changes: CloudEnvelope[];
  nextVersion: number;
  hasMore: boolean;
  recordCount: number;
  serverTime: string;
}

interface SyncEngineOptions {
  deviceId: string;
  onState: (state: SyncEngineState) => void;
  onProfile?: (profile: CloudProfile) => void;
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
}

type AttachmentCloudData = Omit<AttachmentRecord, "blob"> & { blobVersion: number };
type PreparedQueueItem = { item: SyncQueueItem; candidate: CloudEnvelope };

const API_URL = "/api/sync";
const PUSH_BATCH_SIZE = 25;

export class D1SyncEngine {
  private readonly deviceId: string;
  private readonly onState: SyncEngineOptions["onState"];
  private readonly onProfile?: SyncEngineOptions["onProfile"];
  private readonly fetcher: typeof fetch;
  private readonly pollIntervalMs: number;
  private syncPromise?: Promise<void>;
  private bootstrapPromise?: Promise<void>;
  private pollTimer?: number;
  private ownerId?: string;
  private bootstrapped = false;
  private stopped = false;

  private readonly onlineHandler = () => { void this.bootstrap().catch(() => undefined); };
  private readonly offlineHandler = () => { void this.emit("offline"); };
  private readonly localChangeHandler = () => { void this.syncNow().catch(() => undefined); };
  private readonly focusHandler = () => { if (navigator.onLine) void this.syncNow().catch(() => undefined); };
  private readonly visibilityHandler = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void this.syncNow().catch(() => undefined);
  };

  constructor(options: SyncEngineOptions) {
    this.deviceId = options.deviceId;
    this.onState = options.onState;
    this.onProfile = options.onProfile;
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
  }

  async start() {
    window.addEventListener("online", this.onlineHandler);
    window.addEventListener("offline", this.offlineHandler);
    window.addEventListener("focus", this.focusHandler);
    window.addEventListener("qinglan:local-change", this.localChangeHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    if (this.pollIntervalMs > 0) {
      this.pollTimer = window.setInterval(() => {
        if (!this.stopped && navigator.onLine && document.visibilityState === "visible") {
          void this.syncNow().catch(() => undefined);
        }
      }, this.pollIntervalMs);
    }

    const cached = await readCachedProfile();
    if (cached) this.onProfile?.(cached);
    if (!navigator.onLine) { await this.emit("offline"); return; }
    await this.bootstrap();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    window.removeEventListener("online", this.onlineHandler);
    window.removeEventListener("offline", this.offlineHandler);
    window.removeEventListener("focus", this.focusHandler);
    window.removeEventListener("qinglan:local-change", this.localChangeHandler);
    document.removeEventListener("visibilitychange", this.visibilityHandler);
  }

  syncNow(): Promise<void> {
    if (!this.bootstrapped) return this.bootstrap();
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => { this.syncPromise = undefined; });
    return this.syncPromise;
  }

  private bootstrap(): Promise<void> {
    if (this.bootstrapped) return this.syncNow();
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = this.performBootstrap().finally(() => { this.bootstrapPromise = undefined; });
    return this.bootstrapPromise;
  }

  private async performBootstrap() {
    if (this.stopped) return;
    if (!navigator.onLine) { await this.emit("offline"); return; }
    await this.emit("syncing");
    try {
      const legacyChanges = await listLegacyCustomizations();
      let response = await this.request([], 0);
      this.ownerId = response.profile.ownerId;
      await cacheProfile(response.profile);
      this.onProfile?.(response.profile);
      const migrationKey = `migration:${this.ownerId}:d1-v1`;
      const migrated = await db.syncMeta.get(migrationKey);
      const cloudWasEmpty = response.recordCount === 0;
      let cursor = 0;

      for (;;) {
        await this.applyEnvelopes(response.changes);
        cursor = response.nextVersion;
        if (!response.hasMore) break;
        response = await this.request([], cursor);
      }

      if (!migrated) {
        if (cloudWasEmpty) {
          if (legacyChanges.length) await queueAllLocalData();
          else await queuePristineSeedData();
          for (const change of legacyChanges) {
            if (change.operation === "delete") await queueLocalChange(change.entityType, change.recordId, "delete");
          }
        } else {
          for (const change of legacyChanges) {
            if (change.operation === "put") await db.table(change.entityType).put(change.value);
            else await db.table(change.entityType).delete(change.recordId);
            await queueLocalChange(change.entityType, change.recordId, change.operation);
          }
        }
        await db.syncMeta.put({
          key: migrationKey,
          value: { completedAt: new Date().toISOString(), cloudWasEmpty },
        });
      }

      await this.writeCursor(cursor);
      this.bootstrapped = true;
      await this.performSync();
    } catch (reason) {
      await this.emit(navigator.onLine ? "error" : "offline", { error: readableSyncError(reason) });
      throw reason;
    }
  }

  private async performSync() {
    if (this.stopped) return;
    if (!navigator.onLine) { await this.emit("offline"); return; }
    await this.emit("syncing");
    try {
      let cursor = await this.readCursor();
      cursor = await this.pullUntilCurrent(cursor);

      for (;;) {
        const queue = await db.syncQueue.orderBy("localUpdatedAt").limit(PUSH_BATCH_SIZE).toArray();
        if (!queue.length) break;
        const prepared = await this.prepareBatch(queue);
        if (!prepared.length) continue;
        const response = await this.request(prepared.map((entry) => entry.candidate), cursor);
        this.acceptProfile(response.profile);
        await this.applyEnvelopes(response.changes);

        for (const winner of response.winners) {
          const local = prepared.find(({ candidate }) => candidate.entityType === winner.entityType && candidate.recordId === winner.recordId);
          if (local && compareVersion(winner, local.candidate) !== 0) await this.applyEnvelope(winner, true);
        }
        for (const { item } of prepared) {
          const current = await db.syncQueue.get(item.id);
          if (current?.localUpdatedAt === item.localUpdatedAt) await db.syncQueue.delete(item.id);
        }

        cursor = response.nextVersion;
        await this.writeCursor(cursor);
        if (response.hasMore) cursor = await this.pullUntilCurrent(cursor);
      }

      const lastSyncedAt = new Date().toISOString();
      if (this.ownerId) await db.syncMeta.put({ key: `lastSync:${this.ownerId}:d1`, value: lastSyncedAt });
      await this.emit("success", { lastSyncedAt });
    } catch (reason) {
      await this.emit(navigator.onLine ? "error" : "offline", { error: readableSyncError(reason) });
      throw reason;
    }
  }

  private async pullUntilCurrent(startCursor: number) {
    let cursor = startCursor;
    for (;;) {
      const response = await this.request([], cursor);
      this.acceptProfile(response.profile);
      await this.applyEnvelopes(response.changes);
      cursor = response.nextVersion;
      await this.writeCursor(cursor);
      if (!response.hasMore) return cursor;
    }
  }

  private async prepareBatch(queue: SyncQueueItem[]): Promise<PreparedQueueItem[]> {
    const result: PreparedQueueItem[] = [];
    for (const item of queue) {
      const latest = await db.syncQueue.get(item.id);
      if (!latest || latest.localUpdatedAt !== item.localUpdatedAt) continue;
      const localRecord = item.operation === "put" ? await getLocalRecord(item.entityType, item.recordId) : undefined;
      if (item.operation === "put" && localRecord === undefined) {
        await db.syncQueue.update(item.id, { operation: "delete" });
        continue;
      }
      const data = item.entityType === "attachments" && localRecord
        ? await serializeAttachment(localRecord as AttachmentRecord)
        : localRecord ? sanitizeForCloud(localRecord) : null;
      result.push({
        item,
        candidate: {
          entityType: item.entityType,
          recordId: item.recordId,
          data,
          deleted: item.operation === "delete",
          clock: item.localUpdatedAt,
          deviceId: item.deviceId,
          schemaVersion: 2,
        },
      });
    }
    return result;
  }

  private async applyEnvelopes(envelopes: CloudEnvelope[]) {
    for (const envelope of envelopes) await this.applyEnvelope(envelope);
  }

  private async applyEnvelope(envelope: CloudEnvelope, force = false) {
    if (!envelope?.entityType || !envelope.recordId || !Number.isFinite(envelope.clock)) return;
    const localStamp = await getRecordStamp(envelope.entityType, envelope.recordId);
    if (!force && compareVersion(envelope, localStamp) <= 0) return;
    const stamp = { clock: envelope.clock, deviceId: envelope.deviceId };
    if (envelope.deleted) {
      await deleteRemoteRecord(envelope.entityType, envelope.recordId, stamp);
      return;
    }
    const value = envelope.entityType === "attachments"
      ? await this.downloadAttachment(envelope.recordId, envelope.data as AttachmentCloudData, envelope.clock)
      : envelope.data;
    if (value) await putRemoteRecord(envelope.entityType, envelope.recordId, value, stamp);
  }

  private async downloadAttachment(recordId: string, data: AttachmentCloudData, clock: number): Promise<AttachmentRecord> {
    const response = await this.fetcher(`${API_URL}/attachments/${encodeURIComponent(recordId)}?clock=${clock}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response);
    const blob = await response.blob();
    return { id: data.id, name: data.name, type: data.type, size: data.size, blob };
  }

  private async request(push: CloudEnvelope[], sinceVersion: number): Promise<SyncResponse> {
    const response = await this.fetcher(API_URL, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: this.deviceId, sinceVersion, push }),
    });
    if (!response.ok) throw await responseError(response);
    const value = await response.json() as Partial<SyncResponse>;
    if (!value.profile?.ownerId || !Array.isArray(value.changes) || !Array.isArray(value.winners) || !Number.isSafeInteger(value.nextVersion)) {
      throw new Error("云同步响应格式无效");
    }
    return value as SyncResponse;
  }

  private acceptProfile(profile: CloudProfile) {
    this.ownerId = profile.ownerId;
    this.onProfile?.(profile);
    void cacheProfile(profile);
  }

  private async readCursor() {
    if (!this.ownerId) return 0;
    const record = await db.syncMeta.get(`cursor:${this.ownerId}:d1-v1`);
    const value = Number(record?.value ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private async writeCursor(value: number) {
    if (this.ownerId) await db.syncMeta.put({ key: `cursor:${this.ownerId}:d1-v1`, value });
  }

  private async emit(status: SyncStatus, patch: Partial<SyncEngineState> = {}) {
    const pendingCount = await db.syncQueue.count();
    this.onState({ status, pendingCount, ...patch });
  }
}

export class CloudSyncError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function responseError(response: Response) {
  let message = `云同步请求失败（${response.status}）`;
  try {
    const value = await response.json() as { error?: string };
    if (value.error) message = value.error;
  } catch { /* 保留状态码消息 */ }
  return new CloudSyncError(response.status, message);
}

async function serializeAttachment(record: AttachmentRecord) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    size: record.size,
    blobBase64: await blobToBase64(record.blob),
  };
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const block = 32_768;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return btoa(binary);
}

async function cacheProfile(profile: CloudProfile) {
  await db.syncMeta.put({ key: "cloudProfile:d1-v1", value: profile });
}

export async function readCachedProfile() {
  const value = (await db.syncMeta.get("cloudProfile:d1-v1"))?.value as CloudProfile | undefined;
  return value?.ownerId && value.email ? value : null;
}

function readableSyncError(reason: unknown) {
  if (reason instanceof CloudSyncError) {
    if (reason.status === 401) return "统一账号登录已失效，请重新登录";
    if (reason.status === 503) return "云数据库正在配置，账目已安全保存在本机";
  }
  return errorMessage(reason);
}
