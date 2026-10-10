-- A schedule with neither `date` nor `rrule` used to mean "fire once at the
-- next localTime". Writers now store that as a dated one-off and the scheduler
-- only fires dated one-offs, so give every such row its date.
--
--   * fired rows → the UTC date they fired on. They are spent; the date only
--     keeps the row well-formed.
--   * unfired rows → the next UTC day whose clock reaches localTime. SQLite
--     has no zone data, so this compares in UTC rather than `tzid`: in a zone
--     far from UTC a pending reminder can land a day off. These rows live at
--     most a day before firing, so we accept that over a boot-time fixup.
--   * every row → `fixed`, like any dated one-off. A `floating` row now fires
--     in its stored `tzid` rather than the guardian's current zone.
--
-- substr('0' || ..., -5) pads a one-digit hour ("9:00") so the times compare
-- as strings.
UPDATE `routines`
SET `trigger` = json_set(
  `trigger`,
  '$.tzMode',
  'fixed',
  '$.date',
  CASE
    WHEN `last_fired_at` IS NOT NULL THEN date(`last_fired_at`, 'unixepoch')
    WHEN substr('0' || json_extract(`trigger`, '$.localTime'), -5) > strftime('%H:%M', 'now')
      THEN date('now')
    ELSE date('now', '+1 day')
  END
)
WHERE json_valid(`trigger`)
  AND json_extract(`trigger`, '$.type') = 'schedule'
  AND coalesce(json_extract(`trigger`, '$.date'), '') = ''
  AND coalesce(json_extract(`trigger`, '$.rrule'), '') = '';
