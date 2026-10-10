-- A schedule with neither `date` nor `rrule` used to mean "fire once at the
-- next localTime". Writers now store that as a dated one-off and the scheduler
-- only fires dated one-offs, so give every such row its date.
--
--   * disabled fired rows → the UTC date they fired on. They are spent; the
--     date only keeps the row well-formed.
--   * every other row, a fired one switched back on included → the next UTC
--     day whose clock reaches localTime. SQLite has no zone data, so that is
--     exact only for a UTC row. Any other zone is up to 14 hours off UTC, and
--     the date it gives can already be past there. So a non-UTC row takes the
--     day after: it never lands in the past, but it can fire a day or two
--     later than before. These rows live at most a day before firing, so we
--     accept that over a boot-time fixup.
--   * every row → `fixed`, like any dated one-off. A `floating` row now fires
--     in its stored `tzid` rather than the guardian's current zone.
--
-- A blank `rrule` goes, so the row holds only its date.
-- substr('0' || ..., -5) pads a one-digit hour ("9:00") so the times compare
-- as strings.
UPDATE `routines`
SET `trigger` = json_remove(json_set(
  `trigger`,
  '$.tzMode',
  'fixed',
  '$.date',
  CASE
    WHEN `enabled` = 0 AND `last_fired_at` IS NOT NULL THEN date(`last_fired_at`, 'unixepoch')
    ELSE date(
      'now',
      CASE
        WHEN substr('0' || json_extract(`trigger`, '$.localTime'), -5) > strftime('%H:%M', 'now')
          THEN '+0 days'
        ELSE '+1 day'
      END,
      CASE WHEN json_extract(`trigger`, '$.tzid') = 'UTC' THEN '+0 days' ELSE '+1 day' END
    )
  END
), '$.rrule')
WHERE json_valid(`trigger`)
  AND json_extract(`trigger`, '$.type') = 'schedule'
  AND coalesce(json_extract(`trigger`, '$.date'), '') = ''
  AND coalesce(json_extract(`trigger`, '$.rrule'), '') = '';
