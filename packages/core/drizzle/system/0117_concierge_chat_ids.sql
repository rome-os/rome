-- The Concierge chat a task came from, and the one a kept event reports to.
-- Null is the main chat, so every existing row stays with it.
ALTER TABLE `concierge_follow_items` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `chat_id` text REFERENCES rome_sessions(id) ON DELETE set null;
