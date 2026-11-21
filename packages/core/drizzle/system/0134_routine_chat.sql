ALTER TABLE `routines` ADD `chat_id` text;--> statement-breakpoint
CREATE INDEX `idx_routines_chat_id` ON `routines` (`chat_id`);--> statement-breakpoint
UPDATE `routines` SET `chat_id` = json_extract(`args`, '$.threadId') WHERE `chat_id` IS NULL AND `action_name` IN ('resume_session', 'system:resume_session', 'send_message', 'system:send_message') AND json_valid(`args`) AND json_type(`args`, '$.threadId') = 'text' AND json_extract(`args`, '$.threadId') <> '';--> statement-breakpoint
UPDATE `routines` SET `chat_id` = json_extract(`args`, '$.sessionId') WHERE `chat_id` IS NULL AND `action_name` IN ('send_user_message', 'system:send_user_message') AND json_valid(`args`) AND json_type(`args`, '$.sessionId') = 'text' AND json_extract(`args`, '$.sessionId') <> '';
