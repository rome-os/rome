-- Feishu and Lark are two platforms, told apart by the Feishu app's domain.
-- Every Feishu channel was minted on `feishu`, so the one whose Connection
-- holds a Lark app moves to `lark`. The setup writes the domain to the app
-- grant's profile, and a grant from before profiles holds it only in its
-- material. A channel whose Connection is gone keeps `feishu`, since nothing
-- names its domain any more.
UPDATE `channels` SET `platform` = 'lark'
WHERE `service` = 'feishu'
  AND `connection_id` IN (
    SELECT `custody` FROM `connection_grants`
    WHERE `name` = 'app'
      AND COALESCE(
        json_extract(`profile`, '$.domain'),
        json_extract(`credential`, '$.material.record.domain')
      ) = 'lark'
  );
