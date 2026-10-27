import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useReplyDraft } from "./reply-draft";
import { findMessageAnchor, replyPreview, selectedQuote, type ReplySource } from "./reply-source";

/**
 * Starts a reply to `source` in the composer. It renders nothing where the
 * chat offers no reply, or where `source` belongs to a session the composer
 * does not send to. A selection that lies inside the message's own element
 * (found by its `data-timeline-anchor`) becomes the quote.
 */
export function ReplyButton({
  source,
  onReply,
  className,
}: {
  source: ReplySource;
  /** Called after the reply is set, e.g. to close the menu holding the button. */
  onReply?: () => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  if (!draft || draft.sessionId !== source.sessionId) return null;
  return (
    <IconButton
      size="sm"
      label={t("reply.action")}
      icon={<Reply />}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={() => {
        const quote = selectedQuote(findMessageAnchor(document, source.messageId), source.text);
        draft.set({
          messageId: source.messageId,
          author: source.author,
          ...(source.name ? { name: source.name } : {}),
          ...(quote ? { quote } : {}),
          preview: replyPreview(quote ?? source.text),
        });
        onReply?.();
      }}
    />
  );
}
