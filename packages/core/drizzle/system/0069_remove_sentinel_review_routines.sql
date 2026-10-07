-- The sentinel_review action is gone. Its boot-created routine would otherwise
-- fail with "Action not found" on every fire, so it goes with the action.
-- routine_runs.routine_id does not cascade, so the run history goes first.
DELETE FROM `routine_runs`
WHERE `routine_id` IN (SELECT `id` FROM `routines` WHERE `action_name` = 'sentinel_review');
--> statement-breakpoint
DELETE FROM `routines` WHERE `action_name` = 'sentinel_review';
--> statement-breakpoint
-- The legacy events table can still hold a sentinel_review schedule that the
-- boot-time events-to-routines conversion would turn back into a routine.
DELETE FROM `events` WHERE `action_name` = 'sentinel_review';
