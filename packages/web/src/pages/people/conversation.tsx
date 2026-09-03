import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import {
  defaultSendAccount,
  type LinkedAccount,
  type PersonResource,
  type TimelineEntry,
} from "@rome/api-types/people";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ChannelGlyph, ChannelPill, channelLabel } from "./channel-meta";
import { Composer } from "./composer";
import { clockTime, dayLabel, navigatorLocale, startOfDay } from "./format";
import { Outbox } from "./outbox";
import {
  ALL_ACCOUNTS,
  accountSegments,
  segmentAccount,
  segmentEntries,
  segmentOutbox,
} from "./send-model";
import { usePersonOutbox, usePersonTimeline } from "./use-roster";

/**
 * A person's conversation: what has been said, what Rome is still trying to
 * say, and the box for saying the next thing.
 *
 * Two views, both able to send. "All" is the merged timeline the dossier has
 * always shown, with a composer whose target is named on screen and changed in
 * one click. An account view scopes the same three blocks to one account, and
 * its composer takes no picker at all — the view is the target, and asking the
 * guardian to choose again inside it would be asking twice.
 *
 * The segments are per account rather than per channel ({@link accountSegments}
 * for why), and the merged view's target is `defaultSendAccount`'s — the
 * contract's, so no second rule here can decide who receives a message.
 */
export function PersonConversation({ person }: { person: PersonResource }) {
  const { t } = useTranslation("people");
  const timeline = usePersonTimeline(person.id);
  const outbox = usePersonOutbox(person.id);

  const segments = useMemo(() => accountSegments(person.accounts), [person.accounts]);
  const [segment, setSegment] = useState<string>(ALL_ACCOUNTS);
  // A segment survives a merge or an unlink that takes its account away, so the
  // lookup answers null and the view falls back to the merged one rather than
  // scoping to an account this person no longer holds.
  const scoped = segmentAccount(segments, segment);

  // Only in the merged view, and only until the guardian picks: an account view
  // has no override to hold, and the default is the contract's answer to which
  // account a composer opens on.
  const [override, setOverride] = useState<LinkedAccount | null>(null);
  const chosen =
    override && person.accounts.some((a) => sameAccount(a, override)) ? override : null;
  const target = scoped ?? chosen ?? defaultSendAccount(person.accounts);

  const entries = segmentEntries(timeline.entries, scoped);
  const days = useMemo(() => groupByDay(entries), [entries]);

  return (
    // A column that takes the rest of the page, so the composer's floor can sit
    // at the bottom of the viewport even when the history above it is short.
    <section className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-section uppercase tracking-wide text-muted-foreground">
          {t("detail.timeline")}
        </h2>
        {segments.length > 1 && (
          <SegmentedControl
            aria-label={t("send.segments.label")}
            size="sm"
            value={segment}
            onValueChange={setSegment}
            options={[
              { value: ALL_ACCOUNTS, label: t("send.segments.all") },
              // The channel's own name, and the handle instead where two
              // segments would otherwise both say the same channel — see
              // {@link accountSegments}. Not both: a segment carrying the
              // handle as a second, hidden label would say the address twice
              // to a screen reader for every person who has one account per
              // channel, which is almost everyone.
              ...segments.map((option) => ({
                value: option.value,
                label: option.handle ?? channelLabel(t, option.account.channel),
                icon: <ChannelGlyph channel={option.account.channel} />,
              })),
            ]}
          />
        )}
      </div>

      <Outbox personId={person.id} messages={segmentOutbox(outbox.messages, scoped)} />

      {timeline.isPending ? (
        <p className="py-8 text-center text-aux text-muted-foreground">{t("page.loading")}</p>
      ) : timeline.error ? (
        // Same reason as the person read: "nothing has happened yet" is a
        // claim about this person, and a failed fetch has not earned it.
        <div className="py-4">
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("errors.loadFailedTitle")}</AlertTitle>
            <AlertDescription>{timeline.error.message}</AlertDescription>
          </Alert>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void timeline.refetch()}
          >
            {t("errors.retry")}
          </Button>
        </div>
      ) : days.length === 0 ? (
        // What an empty view means depends on how much it was looking at. "On
        // any channel" is a false claim inside a view that has only ever looked
        // at one.
        <p className="py-8 text-center text-aux text-subtle-foreground">
          {scoped
            ? t("send.segments.empty", { channel: channelLabel(t, scoped.channel) })
            : t("detail.timelineEmpty")}
        </p>
      ) : (
        days.map((day) => (
          <div key={day.dayStart}>
            <h3 className="mt-5 mb-1 text-badge uppercase tracking-wide text-subtle-foreground">
              {dayLabel(t, day.dayStart, navigatorLocale())}
            </h3>
            {day.entries.map((entry) => (
              <div
                key={`${entry.source}:${entry.ref}`}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 border-b border-border-subtle px-2 py-2"
              >
                {/* Off inside an account view, where every row would name the
                    one channel the view is already named after. */}
                {scoped ? <span /> : <ChannelPill channel={entry.source} />}
                <p className="min-w-0 text-ui text-foreground">
                  {entry.direction === "outbound" && (
                    <span className="text-subtle-foreground">{t("detail.outboundPrefix")} </span>
                  )}
                  <span className={entry.direction === "outbound" ? "text-muted-foreground" : ""}>
                    {entry.body ?? t("row.noPreview")}
                  </span>
                </p>
                <span className="font-mono text-badge tabular-nums text-subtle-foreground">
                  {clockTime(entry.timestamp, navigatorLocale())}
                </span>
              </div>
            ))}
          </div>
        ))
      )}

      {timeline.hasNextPage && (
        <div className="flex justify-center pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={timeline.isFetchingNextPage}
            onClick={() => void timeline.fetchNextPage()}
          >
            {t("detail.loadOlder")}
          </Button>
        </div>
      )}

      <Composer person={person} target={target} onChangeTarget={scoped ? null : setOverride} />
    </section>
  );
}

function sameAccount(a: LinkedAccount, b: LinkedAccount): boolean {
  return a.channel === b.channel && a.channelUserId === b.channelUserId;
}

interface TimelineDay {
  dayStart: number;
  entries: TimelineEntry[];
}

/** Entries arrive newest first and stay that way inside each day, so the page
 *  reads top-down as "most recent first" at both levels. */
function groupByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const dayStart = startOfDay(entry.timestamp);
    const current = days.at(-1);
    if (current && current.dayStart === dayStart) current.entries.push(entry);
    else days.push({ dayStart, entries: [entry] });
  }
  return days;
}
