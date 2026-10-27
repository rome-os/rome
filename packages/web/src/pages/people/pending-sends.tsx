import { useTranslation } from "react-i18next";
import { CircleAlert, Clock, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChannelPill } from "./channel-meta";
import type { PendingSend } from "./use-conversation-sends";

/**
 * What this page has asked Rome to send and has not seen land: a send waiting
 * on its answer, and a send the channel refused.
 *
 * Its own block above the timeline rather than rows inside it, because it makes
 * a different claim — "not sent" is not "this happened". A send the channel
 * took leaves this block as its message joins the timeline.
 *
 * The rows are this page's alone. Rome keeps no record of a send it could not
 * make, so a refused send lives until the guardian retries or discards it, or
 * leaves the page.
 */
export function PendingSends({
  sends,
  onRetry,
  onDiscard,
}: {
  sends: readonly PendingSend[];
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const { t } = useTranslation("people");
  if (sends.length === 0) return null;

  return (
    <ul aria-label={t("send.pending.label")} className="mt-3 rounded-14 border border-border p-1">
      {sends.map((send) => (
        <li
          key={send.id}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-2 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
        >
          <ChannelPill channel={send.channel} />
          <p
            className={`min-w-0 break-words text-ui ${
              send.state === "failed" ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {send.text}
          </p>
          {/* Capped, because a channel's error can be a sentence, and an
              uncapped auto column would take the message column's width. */}
          <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-auto sm:max-w-80">
            {send.state === "failed" ? (
              <>
                {/* Usually the channel's own words, which this page can neither
                    localize nor promise the shape of. */}
                <span role="alert" className="flex items-center gap-1 text-badge text-destructive">
                  <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
                  <span>{send.error}</span>
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => onRetry(send.id)}>
                  <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  {t("send.retry")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("send.discard")}
                  onClick={() => onDiscard(send.id)}
                >
                  <X aria-hidden="true" />
                </Button>
              </>
            ) : (
              <span
                role="status"
                className="flex items-center gap-1 text-badge text-muted-foreground"
              >
                <Clock className="size-3" aria-hidden="true" />
                {t("send.state.sending")}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
