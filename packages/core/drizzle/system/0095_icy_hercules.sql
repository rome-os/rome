CREATE TABLE `app_connection_access` (
	`app_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`identity` text NOT NULL,
	`operation` text NOT NULL,
	`approval` text NOT NULL,
	`constraints` text NOT NULL,
	`expires_at` integer,
	`revision` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `connection_id`, `identity`, `operation`)
);
--> statement-breakpoint
CREATE INDEX `idx_app_connection_access_app` ON `app_connection_access` (`app_id`,`connection_id`);--> statement-breakpoint
CREATE TABLE `app_connection_audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`identity` text NOT NULL,
	`operation` text NOT NULL,
	`access_revision` integer,
	`approval` text NOT NULL,
	`execution_id` text NOT NULL,
	`request_id_hash` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_connection_audit_app` ON `app_connection_audit` (`app_id`,`seq`);--> statement-breakpoint
CREATE TABLE `app_connection_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`identity` text NOT NULL,
	`operation` text NOT NULL,
	`request_id_hash` text,
	`input_hash` text NOT NULL,
	`input` text,
	`side_effects` text NOT NULL,
	`access_revision` integer NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_app_connection_invocation_request` ON `app_connection_invocations` (`app_id`,`request_id_hash`) WHERE "app_connection_invocations"."request_id_hash" IS NOT NULL;