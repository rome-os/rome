-- A connection holds one grant, so the grant is keyed by its connection
-- alone. Every kind of connection declares one grant, so a connection with
-- more rows holds one left by a grant a kind no longer declares. The row kept
-- is the one in use: held before unauthorized, then the latest conferred.
DELETE FROM `connection_grants` WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid, ROW_NUMBER() OVER (
      PARTITION BY `custody`
      ORDER BY `state` = 'unauthorized', `conferred_at` DESC, rowid DESC
    ) AS n FROM `connection_grants`
  ) WHERE n = 1
);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connection_grants` (
	`custody` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`credential` text,
	`profile` text,
	`conferred_at` integer,
	`last_renewed_at` integer,
	`degraded_at` integer,
	`degraded_reason` text,
	`platform` text,
	`account_id` text
);
--> statement-breakpoint
INSERT INTO `__new_connection_grants`("custody", "state", "credential", "profile", "conferred_at", "last_renewed_at", "degraded_at", "degraded_reason", "platform", "account_id") SELECT "custody", "state", "credential", "profile", "conferred_at", "last_renewed_at", "degraded_at", "degraded_reason", "platform", "account_id" FROM `connection_grants`;--> statement-breakpoint
DROP TABLE `connection_grants`;--> statement-breakpoint
ALTER TABLE `__new_connection_grants` RENAME TO `connection_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connection_grants_account` ON `connection_grants` (`platform`,`account_id`) WHERE "connection_grants"."account_id" IS NOT NULL AND "connection_grants"."state" != 'unauthorized';