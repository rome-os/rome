-- The channel id of the account a People send went out from. Rows written
-- before it stay null, and confirm and retry as they always have.
ALTER TABLE `outbound_messages` ADD `from_channel` text;