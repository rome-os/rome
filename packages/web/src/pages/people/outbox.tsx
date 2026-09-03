import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Clock, RotateCcw, X } from "lucide-react";
import type { OutboxMessage } from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import { ChannelPill } from "./channel-meta";
import { isDismissable } from "./send-model";
import { usePeopleWrites } from "./use-writes";
import type { WriteOutcome } from "./writes";

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
 * Nothing here reads `OutboxMessage.ref`. It names the entry the message would
 * become at the address it was sent to, and a channel that folds several
 * addresses onto one account can deliver under another of them — recognizing an
 * arrival is the server's job, and by the time the timeline holds the entry this
 * row is already gone.
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
          <OutboxRowActions personId={personId} message={message} />
        </li>
      ))}
    </ul>
  );
}

/**
 * What a row says about itself, and what can be done about it.
 *
 * The two gestures are offered by what the server will accept, which is not one
 * set. Retry is for a `failed` row alone — the only state a refusal can be tried
 * again from. Discard reaches further: a row Rome accepted and never saw arrive
 * is stuck once the landing window has passed, and on a channel with no mirror
 * of its own, dismissing it is the only way it ever leaves.
 *
 * A 404 is not reported. It means the row is not what this page thought it was
 * — already discarded, claimed by a retry that won, or not yet stale enough to
 * dismiss — and the outbox read that follows says which. Alarming the loser of a
 * double-click would be reporting a failure for a message that is being sent.
 *
 * Anything else is. A gesture that never reached the server, or that the server
 * failed on, has changed nothing and is the guardian's to try again — and this
 * row is the one place the attempt can be made, so it has to say what happened
 * and stay usable. Silence there would be a row that looks ignored.
 */
function OutboxRowActions({ personId, message }: { personId: string; message: OutboxMessage }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // `busy` is released in a `finally`, never on the way out of the happy path:
  // a gesture that fails leaves this row on screen, and a row whose only
  // gestures stay disabled is one the guardian can no longer act on at all —
  // an outbox with nothing in flight has stopped polling, so nothing else
  // would bring it back.
  const act =
    <T,>(run: () => Promise<WriteOutcome<T>>) =>
    async () => {
      setBusy(true);
      setFailure(null);
      try {
        const outcome = await run();
        // 404 is the quiet one: the row was not this reader's to act on, and the
        // settle that already ran will say what it is now.
        if (!outcome.ok && "message" in outcome && outcome.status !== 404) {
          setFailure(outcome.message);
        }
      } finally {
        setBusy(false);
      }
    };

  const failed = message.state === "failed";
  // The poll keeps this row re-rendering while anything is in flight, so one
  // crossing the window grows its Discard within a tick of doing so.
  const dismissable = isDismissable(message, Math.floor(Date.now() / 1000));

  return (
    <span className="flex items-center gap-2">
      {failed ? (
        // `error` is what stopped it, shown as the row's detail. Usually the
        // channel's own words, which this page can neither localize nor promise
        // the shape of. One of them is not: a send whose process died before the
        // channel answered carries the server's own equivocal line, because Rome
        // genuinely does not know whether it went out.
        <span className="flex items-center gap-1 text-badge text-destructive">
          <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
          <span>{message.error ?? t("send.state.stopped")}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1 text-badge text-subtle-foreground">
          <Clock className="size-3" aria-hidden="true" />
          {t(message.state === "sending" ? "send.state.sending" : "send.state.unconfirmed")}
        </span>
      )}
      {failed && (
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
      )}
      {dismissable && (
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
      )}
      {failure && (
        <span role="status" className="text-badge text-destructive">
          {failure}
        </span>
      )}
    </span>
  );
}
