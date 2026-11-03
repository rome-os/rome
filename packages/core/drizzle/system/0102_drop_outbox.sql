-- The outbox is removed: a send is one channel call answered in the request,
-- and Rome keeps no record of it beyond its own transcript of what it said.
-- Its rows and the receipts of finished sends go with it.
DROP TABLE `outbound_messages`;--> statement-breakpoint
DROP TABLE `outbound_send_receipts`;