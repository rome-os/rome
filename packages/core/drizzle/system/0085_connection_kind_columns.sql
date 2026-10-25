-- What a guardian picks when connecting is a connection kind
-- (docs/domains/connections.md#connection-kind), so the columns that hold
-- one say so. Renaming keeps every row.
ALTER TABLE `connections` RENAME COLUMN `service` TO `connection_kind`;--> statement-breakpoint
ALTER TABLE `channels` RENAME COLUMN `service` TO `connection_kind`;
