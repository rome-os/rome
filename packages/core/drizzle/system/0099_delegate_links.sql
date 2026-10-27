ALTER TABLE `channel_mappings` ADD `delegate` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Every agent the Rome Cloud admission linked to the guardian is recorded in
-- one setting. Each of those links still on the guardian is a delegate link:
-- the agent's own account, attributed to the person behind the agent. A link
-- the guardian has since moved to someone else was the guardian's own act and
-- stays unmarked.
--
-- Nothing stored says who made a link, so an admitted agent the guardian
-- unlinked and then linked back to themselves by hand is marked too. That
-- account is still the guardian's agent, as Rome Cloud stated, and unlinking
-- and linking it again clears the mark. Leaving every admitted link unmarked
-- instead would be wrong for all of them, with no way to set the mark.
UPDATE `channel_mappings` SET `delegate` = 1
WHERE `channel` = 'agents'
  AND `channel_user_id` IN (
    SELECT `ids`.`value` FROM `settings`, json_each(`settings`.`value`) AS `ids`
    WHERE `settings`.`key` = 'agentsGuardianLinkedAgentIds'
  )
  AND `person_id` IN (SELECT `id` FROM `persons` WHERE `bond_level` = 'guardian');
