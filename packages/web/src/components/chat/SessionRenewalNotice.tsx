import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";

const renewalSchema = z.object({ handoff: z.string().nullable() });

/** The handoff a renewal started session `sessionId` of chat `chatId` from, or null. */
async function fetchHandoff(chatId: string, sessionId: string): Promise<string | null> {
  const raw = await fetchJson<unknown>(
    `/api/chat/sessions/${encodeURIComponent(chatId)}/renewals/${encodeURIComponent(sessionId)}`,
    { fallback: "Failed to load the handoff" },
  );
  return renewalSchema.parse(raw).handoff;
}

/**
 * A faint centered line where the chat's agent session was renewed, with the
 * reason, so the guardian can see how often it happens. A reason this build
 * does not know shows as it came. When the renewal wrote a handoff for the
 * new session, the line opens to show it.
 */
export function SessionRenewalNotice({
  reason,
  renewal,
  className,
}: {
  reason: string;
  /** The chat and the renewed session, which a handoff is read by. Absent, the line never opens. */
  renewal?: { chatId: string; sessionId: string };
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const text = t("sessionRenewal.notice", {
    reason: t(`sessionRenewal.reasons.${reason}`, { defaultValue: reason }),
  });
  if (renewal) {
    return (
      <RenewalWithHandoff reason={reason} text={text} renewal={renewal} className={className} />
    );
  }
  return <PlainNotice reason={reason} text={text} className={className} />;
}

function PlainNotice({
  reason,
  text,
  className,
}: {
  reason: string;
  text: string;
  className?: string;
}) {
  return (
    <p
      role="note"
      data-session-renewal={reason}
      className={cn("mb-4 text-center text-aux text-muted-foreground opacity-70", className)}
    >
      {text}
    </p>
  );
}

/** The line, which opens to the handoff once one is found; without one it stays plain. */
function RenewalWithHandoff({
  reason,
  text,
  renewal,
  className,
}: {
  reason: string;
  text: string;
  renewal: { chatId: string; sessionId: string };
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const handoff = useQuery({
    queryKey: ["session-renewal-handoff", renewal.chatId, renewal.sessionId],
    queryFn: () => fetchHandoff(renewal.chatId, renewal.sessionId),
    // A handoff is written once, with the session.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const note = handoff.data;
  if (!note) return <PlainNotice reason={reason} text={text} className={className} />;
  return (
    <div data-session-renewal={reason} className={cn("mb-4 flex flex-col items-center", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="rounded-4 text-center text-aux text-muted-foreground opacity-70 outline-1 outline-offset-0 outline-transparent transition-colors hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        {text} · {open ? t("sessionRenewal.hideHandoff") : t("sessionRenewal.showHandoff")}
      </button>
      {open ? (
        <div
          id={panelId}
          data-session-handoff
          className="mt-2 w-full max-w-prose rounded-8 border border-border bg-muted/40 px-3 py-2 text-left text-aux text-muted-foreground"
        >
          <p className="mb-1 text-foreground">{t("sessionRenewal.handoffTitle")}</p>
          <p className="whitespace-pre-wrap break-words">{note}</p>
        </div>
      ) : null}
    </div>
  );
}
