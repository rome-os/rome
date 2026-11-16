import { Reply } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ReplyToPart } from "@rome/api-types/chat";
import { cn } from "@/lib/utils";
import type { Adjacent } from "./adjacency";
import { useChatThreads } from "./chat-threads";
import { useReplyDraft } from "./reply-draft";
import { quoteLine } from "./reply-source";

const FOCUS_RING =
  "outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

/**
 * What a click on a reply's quote or connector does, and its accessible name:
 * focus the chat on the reply's thread, held on the reply, while no thread is
 * in focus. While one is, go to the original when the transcript shows it.
 * Without either, `onClick` is absent and the mark is plain.
 */
function useQuoteTarget(part: ReplyToPart, hostId: string | undefined) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const threads = useChatThreads();
  const threadOf = threads && hostId !== undefined ? threads.roots.get(hostId) : undefined;
  const opensThread = draft?.threads === true && draft.thread === null && threadOf !== undefined;
  const threadTitle = threadOf ? threads?.titles.get(threadOf) : undefined;
  if (!draft || !(opensThread || draft.has(part.messageId))) return null;
  return {
    label: t(opensThread ? "reply.openThread" : "reply.jump"),
    onClick: () =>
      opensThread
        ? draft.openThread({ thread: hostId ?? part.messageId, title: threadTitle ?? "" })
        : draft.jump(part.messageId),
  };
}

/**
 * A mark that is a button when it leads somewhere and a plain box otherwise.
 * `name` is its accessible name, which a button without one takes from what
 * its click does.
 */
function QuoteMark({
  part,
  target,
  name,
  side,
  height,
  className,
  children,
}: {
  part: ReplyToPart;
  target: ReturnType<typeof useQuoteTarget>;
  name?: string;
  side?: "start" | "end";
  height?: number;
  className?: string;
  children: ReactNode;
}) {
  const shared = {
    "data-reply-quote": part.messageId,
    "data-side": side,
    style: height === undefined ? undefined : { height },
  };
  if (!target) {
    return (
      <div {...shared} role={name ? "img" : undefined} aria-label={name} className={className}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...shared}
      aria-label={name ?? target.label}
      title={part.text}
      className={cn(className, "cursor-pointer", FOCUS_RING)}
      onClick={target.onClick}
    >
      {children}
    </button>
  );
}

/**
 * The quote a reply carries when it does not sit under what it answers
 * (docs/domains/chats.md#chat-thread): a small reply arrow and one muted line
 * of the quoted message, at the top of the reply's bubble. A message from an
 * automation names it first.
 */
export function QuotedReply({ part, hostId }: { part: ReplyToPart; hostId?: string }) {
  const { t } = useTranslation("chat");
  const target = useQuoteTarget(part, hostId);
  return (
    <QuoteMark
      part={part}
      target={target}
      className={cn(
        "mb-1 flex w-full max-w-72 items-center gap-1 text-left text-aux text-muted-foreground transition-colors",
        target && "hover:text-foreground",
      )}
    >
      <Reply aria-hidden className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
      <span className="min-w-0 truncate">
        {part.author === "automated" ? (
          <>
            <span className="text-badge">{part.name ?? t("senderAutomation")}</span>
            <span aria-hidden> · </span>
          </>
        ) : null}
        {quoteLine(part.text)}
      </span>
    </QuoteMark>
  );
}

/**
 * The mark of a reply that sits under what it answers, in place of a quote: a
 * hook up to the message above, or a line across the gap to the reply above
 * that answers the same message. It grows out of the bubble's outer top corner,
 * in the bubble's colour (`.rome-reply-rail`), `side` being the bubble's side.
 * Its name and tooltip are the quoted text.
 */
export function ReplyConnector({
  part,
  hostId,
  side,
  how,
}: {
  part: ReplyToPart;
  hostId?: string;
  side: "start" | "end";
  how: Adjacent;
}) {
  const target = useQuoteTarget(part, hostId);
  const line = how.kind === "line";
  return (
    <QuoteMark
      part={part}
      target={target}
      name={part.text}
      side={side}
      height={line ? how.gap : undefined}
      className={cn(
        "rome-reply-rail absolute bottom-full flex items-end",
        line ? "w-4" : "h-5 w-8",
        side === "end" ? "right-5 justify-end" : "left-5",
      )}
    >
      <span
        aria-hidden
        className={cn(line ? "rome-reply-line h-full" : "rome-reply-hook h-3.5 w-3.5")}
      />
    </QuoteMark>
  );
}
