import { Reply, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { useReplyDraft } from "./reply-draft";
import { quoteLine } from "./reply-source";

/**
 * The bar across the top of a composer showing what the draft replies to, as
 * the quote it will become: a reply arrow, one muted line, and × at the end.
 * Renders nothing without a reply.
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
      className="mb-2 flex w-full min-w-0 items-center gap-2 pl-1 text-aux text-muted-foreground"
    >
      <Reply aria-hidden className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">
        {target.author === "automated" ? (
          <>
            <span className="text-badge">{target.name ?? t("senderAutomation")}</span>
            <span aria-hidden> · </span>
          </>
        ) : null}
        {quoteLine(target.preview)}
      </span>
      <IconButton
        size="xs"
        label={t("reply.dismiss")}
        icon={<X />}
        onClick={draft.dismiss ?? draft.clear}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      />
    </div>
  );
}
