DROP INDEX `idx_slack_app_messages_chat_said`;--> statement-breakpoint
CREATE INDEX `idx_slack_app_messages_said` ON `slack_app_messages` (`team_id`,`said_at`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_slack_app_messages_chat_said` ON `slack_app_messages` (`team_id`,`channel_id`,`said_at`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_slack_app_timeline_chat_said` ON `slack_app_timeline` (`team_id`,`channel_id`,`said_at`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_slack_app_timeline_said` ON `slack_app_timeline` (`team_id`,`said_at`,`ts`);