-- The Slack sign-in (slack) is no longer a kind, so the registry skips its
-- stored connections and the guardian cannot see or disconnect them. This
-- removes them as a disconnect would: the channel lets go of the connection and
-- keeps its row, a never-placed agent link goes, and the connection and its
-- grant, which holds the tokens, are deleted. Chats, their messages, connected
-- accounts and chat rules stay. Nothing is revoked at Slack.
UPDATE `channels` SET `connection_id` = NULL WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `connection_kind` = 'slack');--> statement-breakpoint
DELETE FROM `connected_accounts_unplaced` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `connection_kind` = 'slack');--> statement-breakpoint
DELETE FROM `connection_grants` WHERE `custody` IN (SELECT `id` FROM `connections` WHERE `connection_kind` = 'slack');--> statement-breakpoint
DELETE FROM `connections` WHERE `connection_kind` = 'slack';
