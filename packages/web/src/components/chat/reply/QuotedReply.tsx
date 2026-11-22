import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReplyToPart } from "@rome/api-types/chat";
import { cn } from "@/lib/utils";
import { useReplyDraft } from "./reply-draft";
import { quoteLine } from "./reply-source";

const FOCUS_RING =
  "outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

/**
 * The quote a reply carries when it does not sit under what it answers
 * (docs/domains/chats.md#chat-thread): a small reply arrow and one muted line
 * of the quoted message, at the top of the reply's bubble. A message from an
 * automation names it first. The quote fills the width of the bubble's
 * content and adds nothing to it (`contain: inline-size`): a long original is
 * cut, and never widens the bubble, whose minimum width a quote sets
 * (ChatBubble). Pressing it opens the reply's chain or goes to the original,
 * where the chat can. `from` is the message that carries the quote.
 */
export function QuotedReply({ part, from }: { part: ReplyToPart; from: string }) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const className =
    "mb-1 flex w-full items-center gap-1 text-left text-aux text-muted-foreground transition-colors [contain:inline-size] [.rome-bubble-on-primary_&]:text-primary-foreground/[0.82]";
  const quoted = (
    <>
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
    </>
  );
  if (!draft?.jump) {
    return (
      <div data-reply-quote={part.messageId} className={className}>
        {quoted}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-reply-quote={part.messageId}
      aria-label={t("reply.jump")}
      title={part.text}
      className={cn(className, "cursor-pointer hover:text-foreground", FOCUS_RING)}
      onClick={() => draft.jump?.(part.messageId, from)}
    >
      {quoted}
    </button>
  );
}
