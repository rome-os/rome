ALTER TABLE `approvals` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `idx_approvals_thread` ON `approvals` (`thread_id`);--> statement-breakpoint
UPDATE `approvals` SET `thread_id` = json_extract(`payload`, '$.channelContext.threadId') WHERE json_valid(`payload`) AND json_type(`payload`, '$.channelContext.threadId') = 'text';