ALTER TABLE `rome_sessions` ADD `rome_credits` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `rome_sessions` SET `rome_credits` = 1, `large_model_selection_by` = 'kept' WHERE `large_model_selection_by` = 'credits';
