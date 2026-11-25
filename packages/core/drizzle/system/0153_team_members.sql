CREATE TABLE `team_members` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_members_one_guardian` ON `team_members` (`role`) WHERE "team_members"."role" = 'guardian';