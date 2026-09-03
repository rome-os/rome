import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Clock, RotateCcw, X } from "lucide-react";
import type { OutboxMessage } from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import { ChannelPill } from "./channel-meta";
import { usePeopleWrites } from "./use-writes";

/**
 * The outbox: what Rome has been asked to send and has not seen arrive.
 *
 * Its own block above the timeline rather than rows inside it, because it makes
 * a different claim — "Rome is still trying" is not "this happened", and the
 * contract keeps the two as two nouns so the timeline's ordering stays free of
 * rows that may yet be withdrawn.
 *
 * It empties itself. A row is gone once its message is on the timeline, which
 * the outbox read is what notices, so there is no "sent" state drawn here: a
 * delivered message is a timeline row and this block is where it is not.
 *
 * `failed` is the one state a guardian can act on, and the only one that
 * persists. Retry reuses the row — the contract's rule, so a second attempt
 * never reads as a second message they did not write — and Discard is the only
 * way a row leaves without having been delivered.
 */
export function Outbox({
  personId,
  messages,
}: {
  personId: string;
  messages: readonly OutboxMessage[];
}) {
  const { t } = useTranslation("people");
  if (messages.length === 0) return null;

  return (
    <ul aria-label={t("send.outbox.label")} className="mt-3 rounded-14 border border-border p-1">
      {messages.map((message) => (
        <li
          key={message.id}
          className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-2 py-2"
        >
          <ChannelPill channel={message.channel} />
          <p
            className={`min-w-0 text-ui ${
              message.state === "failed" ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {message.text}
          </p>
          {message.state === "failed" ? (
            <FailedRow personId={personId} message={message} />
          ) : (
            <span className="flex items-center gap-1 text-badge text-subtle-foreground">
              <Clock className="size-3" aria-hidden="true" />
              {t(message.state === "sending" ? "send.state.sending" : "send.state.unconfirmed")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A send Rome has stopped trying to deliver, with the two gestures that can end
 * it.
 *
 * `error` is what stopped it, shown as the row's detail. Usually the channel's
 * own words, which this page can neither localize nor promise the shape of. One
 * of them is not: a send whose process died before the channel answered carries
 * the server's own equivocal line, because Rome genuinely does not know whether
 * it went out. Both read as the reason this row is waiting, which is what the
 * slot is for.
 *
 * Neither gesture reports its own refusal. A 404 here means the row is not what
 * this page thought it was — already discarded, or claimed by a retry that won —
 * and the outbox read that follows says which. Alarming the loser of a
 * double-click would be reporting a failure for a message that is being sent.
 */
function FailedRow({ personId, message }: { personId: string; message: OutboxMessage }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [busy, setBusy] = useState(false);

  // Released once the read behind the gesture has settled. Not left set: a
  // refused gesture leaves this row on screen, and a row whose only two
  // gestures stay disabled is one the guardian can no longer act on at all.
  const act = (run: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1 text-badge text-destructive">
        <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
        <span>{message.error ?? t("send.state.stopped")}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={act(() => writes.retry(personId, message.id))}
      >
        <RotateCcw aria-hidden="true" />
        {t("send.retry")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t("send.discard")}
        disabled={busy}
        onClick={act(() => writes.discard(personId, message.id))}
      >
        <X aria-hidden="true" />
      </Button>
    </span>
  );
}
