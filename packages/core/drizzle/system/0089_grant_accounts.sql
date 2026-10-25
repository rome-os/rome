ALTER TABLE `connection_grants` ADD `platform` text;--> statement-breakpoint
ALTER TABLE `connection_grants` ADD `account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_connection_grants_account` ON `connection_grants` (`platform`,`account_id`) WHERE "connection_grants"."account_id" IS NOT NULL AND "connection_grants"."state" != 'unauthorized';