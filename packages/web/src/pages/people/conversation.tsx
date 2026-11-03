import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { accountRef, defaultSendAccount, type PersonResource } from "@rome/api-types/people";
import type { Message } from "@rome/api-types/message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ChannelGlyph, channelLabel } from "./channel-meta";
import { Composer } from "./composer";
import { clockTime, dayLabel, navigatorLocale, startOfDay } from "./format";
import { PendingSends } from "./pending-sends";
import { accountSegments, segmentAccount, segmentSends } from "./send-model";
import { useAccountTimeline } from "./use-roster";
import { useConversationSends } from "./use-conversation-sends";

/**
 * A person's conversation on one of their accounts: what has been said there,
 * what this page has not managed to send there yet, and the box for saying
 * the next thing.
 *
 * One account at a time. A person has no history joined across their
 * accounts, so the switcher picks the account and the three blocks below it
 * follow. The composer takes no picker: the account on screen is the one a
 * message goes to, and asking the guardian to choose again would be asking
 * twice.
 *
 * The page opens on `defaultSendAccount`'s answer, the contract's, so no
 * second rule here decides who receives a message.
 */
export function PersonConversation({ person }: { person: PersonResource }) {
  const { t } = useTranslation("people");
  const sends = useConversationSends(person.id);

  const segments = useMemo(() => accountSegments(person.accounts), [person.accounts]);
  const fallback = defaultSendAccount(person.accounts) ?? person.accounts[0] ?? null;
  // The account the page opened on is held as a choice from the first render,
  // so a refetch that changes which account is the default does not move the
  // timeline and the composer's target under the guardian. A choice survives
  // a merge or an unlink that takes its account away, so the lookup answers
  // null and the view falls back to the default rather than to an account
  // this person no longer holds.
  const [segment, setSegment] = useState<string | null>(() =>
    fallback ? accountRef(fallback) : null,
  );
  const account = (segment !== null ? segmentAccount(segments, segment) : null) ?? fallback;
  const timeline = useAccountTimeline(person.id, account);

  const days = useMemo(() => groupByDay(timeline.entries), [timeline.entries]);

  return (
    // A column that takes the rest of the page, so the composer's floor can sit
    // at the bottom of the viewport even when the history above it is short.
    <section className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-section uppercase tracking-wide text-muted-foreground">
          {t("detail.timeline")}
        </h2>
        {segments.length > 1 && account && (
          <SegmentedControl
            aria-label={t("send.segments.label")}
            size="sm"
            value={accountRef(account)}
            onValueChange={setSegment}
            // The channel's own name, and the handle instead where two
            // segments would otherwise both say the same channel — see
            // {@link accountSegments}. Not both: a segment carrying the handle
            // as a second, hidden label would say the address twice to a
            // screen reader for every person who has one account per channel,
            // which is almost everyone.
            options={segments.map((option) => ({
              value: option.value,
              label: option.handle ?? channelLabel(t, option.account.channel),
              icon: <ChannelGlyph channel={option.account.channel} />,
            }))}
          />
        )}
      </div>

      <PendingSends
        sends={account ? segmentSends(sends.sends, account) : []}
        onRetry={sends.retry}
        onDiscard={sends.discard}
      />

      {!account ? (
        <p className="py-8 text-center text-aux text-subtle-foreground">
          {t("detail.timelineEmpty")}
        </p>
      ) : timeline.isPending ? (
        <p className="py-8 text-center text-aux text-muted-foreground">{t("page.loading")}</p>
      ) : timeline.error ? (
        // Same reason as the person read: "nothing has happened yet" is a
        // claim about this account, and a failed fetch has not earned it.
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
        <p className="py-8 text-center text-aux text-subtle-foreground">
          {t("send.segments.empty", { channel: channelLabel(t, account.channel) })}
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
                className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b border-border-subtle px-2 py-2"
              >
                <p className="min-w-0 text-ui text-foreground">
                  {entry.direction === "outbound" && (
                    <span className="text-subtle-foreground">{t("detail.outboundPrefix")} </span>
                  )}
                  {/* Pre-wrap keeps a message's line breaks, so a link never runs into the
                      line under it. */}
                  <span
                    className={`whitespace-pre-wrap break-words ${
                      entry.direction === "outbound" ? "text-muted-foreground" : ""
                    }`}
                  >
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

      {account && timeline.hasNextPage && (
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

      <Composer person={person} target={account} onSend={sends.send} />
    </section>
  );
}

interface TimelineDay {
  dayStart: number;
  entries: Message[];
}

/** Entries arrive newest first and stay that way inside each day, so the page
 *  reads top-down as "most recent first" at both levels. */
function groupByDay(entries: readonly Message[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const dayStart = startOfDay(entry.timestamp);
    const current = days.at(-1);
    if (current && current.dayStart === dayStart) current.entries.push(entry);
    else days.push({ dayStart, entries: [entry] });
  }
  return days;
}
