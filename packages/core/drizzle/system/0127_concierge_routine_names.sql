-- The Concierge's digest and follow routines were named after it; a routine's
-- name is shown to its owner, and product copy never says "Concierge". Only a
-- name in the old form changes. The routines are found by their key, never by
-- name, so nothing else moves.
UPDATE `routines` SET `name` = 'Digest at ' || substr(`name`, length('Concierge digest at ') + 1)
WHERE substr(`name`, 1, length('Concierge digest at ')) = 'Concierge digest at ';--> statement-breakpoint
UPDATE `routines` SET `name` = 'Follow ' || substr(`name`, length('Concierge follows ') + 1)
WHERE substr(`name`, 1, length('Concierge follows ')) = 'Concierge follows ';
