-- The person who created a routine; its fires act for them. Null on rows from before.
ALTER TABLE `routines` ADD `created_by` text;
