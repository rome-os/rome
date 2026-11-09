-- Nothing creates a person_mapping approval any more. Stored ones are old
-- pairing requests, shown only as expired history, and approvals filed by the
-- removed add_person_mapping action, whose approve and reject did nothing.
DELETE FROM `approvals` WHERE `type` = 'person_mapping';--> statement-breakpoint
ALTER TABLE `persons` DROP COLUMN `approved`;
