import { Reply, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useReplyDraft } from "./reply-draft";
import { plainQuote } from "./reply-source";

/**
 * The bar across the top of a composer showing the message the draft replies
 * to: a rounded gray left edge, a reply arrow, up to two lines of the quote, and × at the
 * end. Renders nothing without a reply, and nothing on a phone while the
 * thread view is open.
 */
export function ReplyBar() {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const target = draft?.target;
  if (!draft || !target) return null;
  return (
    <div
      data-reply-bar
      title={target.preview}
      className={cn(
        "mb-2 flex w-full min-w-0 items-center gap-2 rounded-8 border-l-3 border-muted-foreground bg-muted/60 py-1 pl-2 pr-1 text-ui text-muted-foreground",
        // On a phone the open thread view shows what the reply answers.
        draft.thread && "max-md:hidden",
      )}
    >
      <span className="flex h-5 shrink-0 items-center" role="img" aria-label={t("reply.action")}>
        <Reply className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        {target.author === "automated" ? (
          <span className="block truncate text-aux">{target.name ?? t("senderAutomation")}</span>
        ) : null}
        <span className="line-clamp-2 break-words">{plainQuote(target.preview)}</span>
      </span>
      <IconButton
        size="xs"
        label={t("reply.dismiss")}
        icon={<X />}
        onClick={draft.clear}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      />
    </div>
  );
}
