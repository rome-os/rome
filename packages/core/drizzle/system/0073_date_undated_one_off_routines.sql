-- A schedule with neither `date` nor `rrule` used to mean "fire once at the
-- next localTime". Writers now store that as a dated one-off and the scheduler
-- only fires dated one-offs, so give every such row its date.
--
--   * disabled fired rows → two days before the UTC date they fired on. They
--     are spent, and the date only keeps the row well-formed. The UTC date
--     can still be ahead in the row's zone, so it would re-arm on re-enable;
--     two days back is past in every zone.
--   * every other row, a fired one switched back on included → the next UTC
--     day whose clock reaches localTime. SQLite has no zone data, so that is
--     exact only for a UTC row (UTC, Etc/UTC, GMT). Any other zone is up to
--     14 hours off UTC, and the date it gives can already be past there. So a non-UTC row takes the
--     day after: it never lands in the past, but it can fire a day or two
--     later than before. These rows live at most a day before firing, so we
--     accept that over a boot-time fixup.
--   * every row → `fixed`, like any dated one-off. A `floating` row followed
--     the guardian, so it first takes the guardian's zone as its `tzid` when
--     one is set, and is then pinned there. With no setting the scheduler
--     fell back to the host zone, which SQL can't read, so the row keeps its
--     stored `tzid`.
--
-- A blank `rrule` goes, so the row holds only its date.
-- substr('0' || ..., -5) pads a one-digit hour ("9:00") so the times compare
-- as strings.
UPDATE `routines`
SET `trigger` = json_set(
  `trigger`,
  '$.tzid',
  (SELECT trim(json_extract(`value`, '$')) FROM `settings` WHERE `key` = 'guardianTimezone')
)
WHERE json_valid(`trigger`)
  AND json_extract(`trigger`, '$.type') = 'schedule'
  AND json_extract(`trigger`, '$.tzMode') = 'floating'
  AND coalesce(json_extract(`trigger`, '$.date'), '') = ''
  AND trim(coalesce(json_extract(`trigger`, '$.rrule'), '')) = ''
  AND coalesce((SELECT trim(json_extract(`value`, '$')) FROM `settings` WHERE `key` = 'guardianTimezone'), '') != '';
--> statement-breakpoint
UPDATE `routines`
SET `trigger` = json_remove(json_set(
  `trigger`,
  '$.tzMode',
  'fixed',
  '$.date',
  CASE
    WHEN `enabled` = 0 AND `last_fired_at` IS NOT NULL THEN date(`last_fired_at`, 'unixepoch', '-2 days')
    ELSE date(
      'now',
      CASE
        WHEN substr('0' || json_extract(`trigger`, '$.localTime'), -5) > strftime('%H:%M', 'now')
          THEN '+0 days'
        ELSE '+1 day'
      END,
      CASE WHEN json_extract(`trigger`, '$.tzid') IN ('UTC', 'Etc/UTC', 'GMT', 'Etc/GMT') THEN '+0 days' ELSE '+1 day' END
    )
  END
), '$.rrule')
WHERE json_valid(`trigger`)
  AND json_extract(`trigger`, '$.type') = 'schedule'
  AND coalesce(json_extract(`trigger`, '$.date'), '') = ''
  AND trim(coalesce(json_extract(`trigger`, '$.rrule'), '')) = '';
