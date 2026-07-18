CREATE TABLE `sync_users` (
  `owner_key` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `display_name` text,
  `created_at` text NOT NULL,
  `last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_devices` (
  `owner_key` text NOT NULL,
  `device_id` text NOT NULL,
  `user_agent` text,
  `last_seen_at` text NOT NULL,
  PRIMARY KEY (`owner_key`, `device_id`),
  FOREIGN KEY (`owner_key`) REFERENCES `sync_users`(`owner_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_sequence` (
  `version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_key` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_records` (
  `owner_key` text NOT NULL,
  `entity_type` text NOT NULL,
  `record_id` text NOT NULL,
  `data_json` text,
  `deleted` integer DEFAULT 0 NOT NULL,
  `clock` integer NOT NULL,
  `device_id` text NOT NULL,
  `schema_version` integer DEFAULT 2 NOT NULL,
  `server_version` integer NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`owner_key`, `entity_type`, `record_id`),
  FOREIGN KEY (`owner_key`) REFERENCES `sync_users`(`owner_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_key` text NOT NULL,
  `entity_type` text NOT NULL,
  `record_id` text NOT NULL,
  `data_json` text,
  `deleted` integer DEFAULT 0 NOT NULL,
  `clock` integer NOT NULL,
  `device_id` text NOT NULL,
  `schema_version` integer DEFAULT 2 NOT NULL,
  `server_version` integer,
  `archived_at` text NOT NULL,
  `reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_records_owner_version_idx` ON `sync_records` (`owner_key`, `server_version`);
--> statement-breakpoint
CREATE INDEX `sync_history_owner_record_idx` ON `sync_history` (`owner_key`, `entity_type`, `record_id`, `archived_at`);
--> statement-breakpoint
CREATE INDEX `sync_devices_owner_idx` ON `sync_devices` (`owner_key`, `last_seen_at`);
--> statement-breakpoint
CREATE TRIGGER `sync_records_archive_update`
AFTER UPDATE ON `sync_records`
BEGIN
  INSERT INTO `sync_history` (
    `owner_key`, `entity_type`, `record_id`, `data_json`, `deleted`, `clock`, `device_id`,
    `schema_version`, `server_version`, `archived_at`, `reason`
  ) VALUES (
    OLD.`owner_key`, OLD.`entity_type`, OLD.`record_id`, OLD.`data_json`, OLD.`deleted`, OLD.`clock`, OLD.`device_id`,
    OLD.`schema_version`, OLD.`server_version`, datetime('now'), 'overwritten'
  );
END;

