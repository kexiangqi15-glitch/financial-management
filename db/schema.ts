/**
 * Cloud persistence schema shared by the Worker and tests.
 * The executable SQL migration lives in drizzle/0000_d1_cloud_sync.sql.
 */
export const CLOUD_SCHEMA_VERSION = 3 as const;

export const CLOUD_TABLES = {
  users: "sync_users",
  devices: "sync_devices",
  records: "sync_records",
  history: "sync_history",
  sequence: "sync_sequence",
} as const;

export interface StoredSyncRecord {
  owner_key: string;
  entity_type: string;
  record_id: string;
  data_json: string | null;
  deleted: number;
  clock: number;
  device_id: string;
  schema_version: number;
  server_version: number;
  updated_at: string;
}
