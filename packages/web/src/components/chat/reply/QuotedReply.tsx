import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReplyToPart } from "@rome/api-types/chat";
import { cn } from "@/lib/utils";
import { useReplyDraft } from "./reply-draft";
import { plainQuote } from "./reply-source";

/**
 * The quote a reply carries, inside the reply's bubble: a gray left edge, a
 * reply arrow, and the first two lines of what was quoted. It jumps to the original when the
 * loaded transcript holds it, and is plain text otherwise.
 */
export function QuotedReply({ part }: { part: ReplyToPart }) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const jumpable = draft?.has(part.messageId) === true;
  const body = (
    <>
      <span className="flex h-5 shrink-0 items-center" role="img" aria-label={t("reply.action")}>
        <Reply className="size-3.5" aria-hidden />
      </span>
      <span className="line-clamp-2 min-w-0 break-words text-ui">{plainQuote(part.text)}</span>
    </>
  );
  const frame =
    "mb-2 flex w-full gap-2 rounded-8 border-l-3 border-muted-foreground bg-muted px-2 py-1 text-left text-muted-foreground";
  if (!draft || !jumpable) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      aria-label={t("reply.jump")}
      className={cn(frame, "cursor-pointer transition-colors hover:bg-border")}
      onClick={() => draft.jump(part.messageId)}
    >
      {body}
    </button>
  );
}
