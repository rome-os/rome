-- The profile each visitor last signed in with, so chat can show who sent a
-- message. New and empty: it fills as visitors sign in.
CREATE TABLE `visitor_profiles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`avatar_url` text,
	`updated_at` integer NOT NULL
);
