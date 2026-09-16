CREATE TABLE `sync_external_links` (
  `code_hash` text PRIMARY KEY NOT NULL,
  `owner_key` text NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text NOT NULL,
  `revoked_at` text,
  FOREIGN KEY (`owner_key`) REFERENCES `sync_users`(`owner_key`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `sync_external_links_owner_idx` ON `sync_external_links` (`owner_key`, `revoked_at`);
