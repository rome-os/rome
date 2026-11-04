-- An important follow item the Concierge left untold goes to the digest
-- instead of being dropped (src/concierge/following.ts).
ALTER TABLE `concierge_follow_items` ADD `deferred_at` integer;