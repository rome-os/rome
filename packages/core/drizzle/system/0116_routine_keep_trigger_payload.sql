-- A routine can keep its runs free of the payload that fired them
-- (src/routines/engine.ts). Every existing routine keeps it, as before.
ALTER TABLE `routines` ADD `keep_trigger_payload` integer DEFAULT true NOT NULL;