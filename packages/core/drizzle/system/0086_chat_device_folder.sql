-- A chat can work in a folder on a rome-node device. The column is nullable,
-- so every existing session reads as having none.
ALTER TABLE `rome_sessions` ADD `device_folder` text;