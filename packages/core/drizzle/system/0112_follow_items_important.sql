-- Triage marks an event important instead of telling the Concierge to notify
-- now (src/concierge/triage.ts). Rows stored under the old word move over.
UPDATE `concierge_follow_items` SET `decision` = 'important' WHERE `decision` = 'notify';
