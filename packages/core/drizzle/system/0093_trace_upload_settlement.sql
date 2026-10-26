ALTER TABLE `rome_trace_archive_deletes` ADD `remote_uncertain` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rome_trace_archives` ADD `upload_may_finish` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `rome_trace_archives` SET `upload_may_finish` = 1 WHERE `location` LIKE 's3:%';
