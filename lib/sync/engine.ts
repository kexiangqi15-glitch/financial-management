import {
  collection,
  doc,
  getDoc,
  getDocsFromServer,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import {
  db,
  deleteRemoteRecord,
  getLocalRecord,
  getRecordStamp,
  listLegacyCustomizations,
  putRemoteRecord,
  queueAllLocalData,
  queueLocalChange,
} from "../db";
import type { AttachmentRecord, SyncEntity, SyncQueueItem } from "../types";
import { compareVersion, errorMessage, recordDocumentId, remoteShouldApply, sanitizeForFirestore, splitBase64, type CloudEnvelope } from "./core";

export type SyncStatus = "offline" | "syncing" | "success" | "error";

export interface SyncEngineState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt?: string;
  error?: string;
}

interface SyncEngineOptions {
  firestore: Firestore;
  uid: string;
  deviceId: string;
  profile: { email: string | null; displayName: string | null; photoURL: string | null };
  onState: (state: SyncEngineState) => void;
}

type AttachmentCloudData = Omit<AttachmentRecord, "blob"> & { blobVersion: number; chunkCount: number };

export class FirestoreSyncEngine {
  private readonly firestore: Firestore;
  private readonly uid: string;
  private readonly deviceId: string;
  private readonly profile: SyncEngineOptions["profile"];
  private readonly onState: SyncEngineOptions["onState"];
  private unsubscribeSnapshot?: Unsubscribe;
  private syncPromise?: Promise<void>;
  private bootstrapPromise?: Promise<void>;
  private bootstrapped = false;
  private stopped = false;
  private readonly onlineHandler = () => { void this.bootstrap().catch(() => undefined); };
  private readonly offlineHandler = () => { void this.emit("offline"); };
  private readonly localChangeHandler = () => { void this.syncNow().catch(() => undefined); };

  constructor(options: SyncEngineOptions) {
    this.firestore = options.firestore;
    this.uid = options.uid;
    this.deviceId = options.deviceId;
    this.profile = options.profile;
    this.onState = options.onState;
  }

  private recordsCollection() {
    return collection(this.firestore, "users", this.uid, "records");
  }

  private recordReference(entityType: SyncEntity, recordId: string) {
    return doc(this.recordsCollection(), recordDocumentId(entityType, recordId));
  }

  async start() {
    window.addEventListener("online", this.onlineHandler);
    window.addEventListener("offline", this.offlineHandler);
    window.addEventListener("qinglan:local-change", this.localChangeHandler);
    if (!navigator.onLine) { await this.emit("offline"); return; }
    await this.bootstrap();
  }

  private bootstrap(): Promise<void> {
    if (this.bootstrapped) return this.syncNow();
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = this.performBootstrap().finally(() => { this.bootstrapPromise = undefined; });
    return this.bootstrapPromise;
  }

  private async performBootstrap() {
    if (this.stopped || !navigator.onLine) { await this.emit("offline"); return; }
    await setDoc(doc(this.firestore, "users", this.uid), {
      ...this.profile,
      schemaVersion: 2,
      lastSeenAt: serverTimestamp(),
    }, { merge: true });
    await setDoc(doc(this.firestore, "users", this.uid, "devices", this.deviceId), {
      platform: navigator.userAgent,
      lastSeenAt: serverTimestamp(),
    }, { merge: true });
    await this.migrateAndPull();
    this.subscribeRealtime();
    this.bootstrapped = true;
    await this.performSync();
  }

  stop() {
    this.stopped = true;
    this.unsubscribeSnapshot?.();
    window.removeEventListener("online", this.onlineHandler);
    window.removeEventListener("offline", this.offlineHandler);
    window.removeEventListener("qinglan:local-change", this.localChangeHandler);
  }

  syncNow(): Promise<void> {
    if (!this.bootstrapped) return this.bootstrap();
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => { this.syncPromise = undefined; });
    return this.syncPromise;
  }

  private async performSync() {
    if (this.stopped) return;
    if (!navigator.onLine) { await this.emit("offline"); return; }
    await this.emit("syncing");
    try {
      await this.pullFromServer();
      let queue = await db.syncQueue.orderBy("localUpdatedAt").toArray();
      while (queue.length) {
        for (const item of queue) await this.pushQueueItem(item);
        queue = await db.syncQueue.orderBy("localUpdatedAt").toArray();
      }
      const lastSyncedAt = new Date().toISOString();
      await db.syncMeta.put({ key: `lastSync:${this.uid}`, value: lastSyncedAt });
      await this.emit("success", { lastSyncedAt });
    } catch (reason) {
      await this.emit(navigator.onLine ? "error" : "offline", { error: errorMessage(reason) });
      throw reason;
    }
  }

  private async migrateAndPull() {
    const migrationKey = `migration:${this.uid}:v2`;
    const migrated = await db.syncMeta.get(migrationKey);
    const legacyChanges = migrated ? [] : await listLegacyCustomizations();
    const snapshot = await getDocsFromServer(this.recordsCollection());
    for (const item of snapshot.docs) {
      const envelope = item.data() as CloudEnvelope;
      await this.applyEnvelope(envelope);
    }
    if (!migrated) {
      if (snapshot.empty) {
        await queueAllLocalData();
        for (const change of legacyChanges) if (change.operation === "delete") await queueLocalChange(change.entityType, change.recordId, "delete");
      } else {
        for (const change of legacyChanges) {
          if (change.operation === "put") await db.table(change.entityType).put(change.value);
          else await db.table(change.entityType).delete(change.recordId);
          await queueLocalChange(change.entityType, change.recordId, change.operation);
        }
      }
      await db.syncMeta.put({ key: migrationKey, value: { completedAt: new Date().toISOString(), cloudWasEmpty: snapshot.empty } });
    }
  }

  private async pullFromServer() {
    const snapshot = await getDocsFromServer(this.recordsCollection());
    for (const item of snapshot.docs) await this.applyEnvelope(item.data() as CloudEnvelope);
  }

  private subscribeRealtime() {
    this.unsubscribeSnapshot = onSnapshot(this.recordsCollection(), { includeMetadataChanges: true }, async (snapshot) => {
      if (this.stopped) return;
      try {
        for (const change of snapshot.docChanges()) {
          if (change.type !== "removed" && !change.doc.metadata.hasPendingWrites) await this.applyEnvelope(change.doc.data() as CloudEnvelope);
        }
        if (snapshot.metadata.fromCache && !navigator.onLine) await this.emit("offline");
      } catch (reason) {
        await this.emit("error", { error: errorMessage(reason) });
      }
    }, (reason) => { void this.emit("error", { error: errorMessage(reason) }); });
  }

  private async pushQueueItem(item: SyncQueueItem) {
    const latest = await db.syncQueue.get(item.id);
    if (!latest || latest.localUpdatedAt !== item.localUpdatedAt) return;
    try {
      const localRecord = item.operation === "put" ? await getLocalRecord(item.entityType, item.recordId) : undefined;
      if (item.operation === "put" && localRecord === undefined) {
        await db.syncQueue.update(item.id, { operation: "delete" });
        return;
      }
      const data = item.entityType === "attachments" && localRecord
        ? await this.uploadAttachment(localRecord as AttachmentRecord, item.localUpdatedAt)
        : localRecord ? sanitizeForFirestore(localRecord) : null;
      const candidate: CloudEnvelope = {
        entityType: item.entityType,
        recordId: item.recordId,
        data,
        deleted: item.operation === "delete",
        clock: item.localUpdatedAt,
        deviceId: item.deviceId,
        schemaVersion: 2,
        updatedAt: serverTimestamp(),
      };
      const reference = this.recordReference(item.entityType, item.recordId);
      let winner = candidate;
      await runTransaction(this.firestore, async (transaction) => {
        const currentSnapshot = await transaction.get(reference);
        if (!currentSnapshot.exists()) {
          transaction.set(reference, candidate);
          return;
        }
        const current = currentSnapshot.data() as CloudEnvelope;
        const localWins = compareVersion(candidate, current) >= 0;
        const historyValue = localWins ? current : candidate;
        const historyId = `${historyValue.clock}-${historyValue.deviceId}`;
        transaction.set(doc(collection(reference, "history"), historyId), { ...historyValue, archivedAt: serverTimestamp() });
        if (localWins) transaction.set(reference, candidate);
        else winner = current;
      });
      if (winner !== candidate) await this.applyEnvelope(winner, true);
      const currentQueue = await db.syncQueue.get(item.id);
      if (currentQueue?.localUpdatedAt === item.localUpdatedAt) await db.syncQueue.delete(item.id);
    } catch (reason) {
      await db.syncQueue.update(item.id, { attempts: item.attempts + 1, lastError: errorMessage(reason) });
      throw reason;
    }
  }

  private async applyEnvelope(envelope: CloudEnvelope, force = false) {
    if (!envelope?.entityType || !envelope.recordId || !Number.isFinite(envelope.clock)) return;
    const localStamp = await getRecordStamp(envelope.entityType, envelope.recordId);
    if (!force && !remoteShouldApply(envelope, localStamp)) return;
    const stamp = { clock: envelope.clock, deviceId: envelope.deviceId };
    if (envelope.deleted) {
      await deleteRemoteRecord(envelope.entityType, envelope.recordId, stamp);
      return;
    }
    const value = envelope.entityType === "attachments"
      ? await this.downloadAttachment(envelope.data as AttachmentCloudData)
      : envelope.data;
    if (value) await putRemoteRecord(envelope.entityType, envelope.recordId, value, stamp);
  }

  private async uploadAttachment(record: AttachmentRecord, clock: number): Promise<AttachmentCloudData> {
    const base64 = await blobToBase64(record.blob);
    const chunks = splitBase64(base64);
    for (let offset = 0; offset < chunks.length; offset += 400) {
      const batch = writeBatch(this.firestore);
      chunks.slice(offset, offset + 400).forEach((data, innerIndex) => {
        const index = offset + innerIndex;
        const chunkId = attachmentChunkId(record.id, clock, index);
        batch.set(doc(this.firestore, "users", this.uid, "attachmentChunks", chunkId), { attachmentId: record.id, blobVersion: clock, index, data });
      });
      await batch.commit();
    }
    return { id: record.id, name: record.name, type: record.type, size: record.size, blobVersion: clock, chunkCount: chunks.length };
  }

  private async downloadAttachment(data: AttachmentCloudData): Promise<AttachmentRecord> {
    const chunks: string[] = [];
    for (let index = 0; index < data.chunkCount; index += 1) {
      const chunk = await getDoc(doc(this.firestore, "users", this.uid, "attachmentChunks", attachmentChunkId(data.id, data.blobVersion, index)));
      if (!chunk.exists()) throw new Error(`附件 ${data.name} 的云端分块不完整`);
      chunks.push(String(chunk.data().data));
    }
    return { id: data.id, name: data.name, type: data.type, size: data.size, blob: base64ToBlob(chunks.join(""), data.type) };
  }

  private async emit(status: SyncStatus, patch: Partial<SyncEngineState> = {}) {
    const pendingCount = await db.syncQueue.count();
    this.onState({ status, pendingCount, ...patch });
  }
}

function attachmentChunkId(id: string, clock: number, index: number) {
  return `${recordDocumentId("attachments", id)}--${clock}--${String(index).padStart(4, "0")}`;
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, type: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}
