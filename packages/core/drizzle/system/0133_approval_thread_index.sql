-- A dev database that ran this migration's first version has an index of this name on the dropped column.
DROP INDEX IF EXISTS `idx_approvals_thread`;--> statement-breakpoint
CREATE INDEX `idx_approvals_thread` ON `approvals` (json_extract("payload", '$.channelContext.threadId'));
