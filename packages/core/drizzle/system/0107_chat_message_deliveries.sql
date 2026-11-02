-- Which of Rome's accounts each line reached. Small rows under a composite
-- primary key, so WITHOUT ROWID, as in 0106. Nothing writes it until the
-- Chats switch.
CREATE TABLE `chat_message_deliveries` (
	`message_id` integer NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `account_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
