ALTER TABLE `concierge_message_turns` ADD `turn_failed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `report_given_up` integer DEFAULT false NOT NULL;