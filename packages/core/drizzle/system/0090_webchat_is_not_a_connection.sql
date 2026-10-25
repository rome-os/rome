-- The dashboard chat is not a connection: no access to an external account was
-- given for it, so no grant ever filled its connection. Rome serves the
-- webchat channel itself, so its connection and that connection's channel
-- record go. Its chats and messages stay where they are.
DELETE FROM `channels` WHERE `connection_id` IN (
  SELECT `id` FROM `connections` WHERE `connection_kind` = 'webchat'
);--> statement-breakpoint
DELETE FROM `connection_grants` WHERE `custody` IN (
  SELECT `id` FROM `connections` WHERE `connection_kind` = 'webchat'
);--> statement-breakpoint
DELETE FROM `connections` WHERE `connection_kind` = 'webchat';
