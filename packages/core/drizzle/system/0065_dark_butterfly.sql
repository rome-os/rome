CREATE TABLE `reply_delivery_parts` (
	`run_id` text NOT NULL,
	`block_ix` integer NOT NULL,
	`part_ix` integer NOT NULL,
	`revision` integer NOT NULL,
	`source_start` integer NOT NULL,
	`source_end` integer NOT NULL,
	`target` text NOT NULL,
	`receipt` text,
	`operation` text NOT NULL,
	`outcome` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `block_ix`, `part_ix`)
);
