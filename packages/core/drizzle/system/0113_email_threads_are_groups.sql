-- An email thread is a group chat keyed by its thread, as the email adapter
-- keys it. 0105 recorded threads as direct messages.
UPDATE `chats` SET `kind` = 'group' WHERE `platform` = 'email';
