-- A main chat was created named "Concierge"; it is "Main chat" now
-- (docs/domains/chats.md#main-chat). Only a main chat still under that name
-- changes, so a name its owner chose stays. A main chat's id is "concierge"
-- for the guardian, and "concierge-v-" with 24 hex digits for a visitor.
UPDATE `rome_sessions` SET `name` = 'Main chat'
WHERE `name` = 'Concierge'
  AND (
    `id` = 'concierge'
    OR (`id` GLOB 'concierge-v-[0-9a-f]*' AND length(`id`) = 36)
  );
