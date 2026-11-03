import { ChevronRight, Forward } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * Where a forwarded report came from, at the top of its bubble: a small chip
 * that opens the task chat. A long title is cut with an ellipsis. The top
 * margin keeps the chip below the 12px of the bubble that the hover toolbar
 * overlaps.
 */
export function ForwardedChip({ chatId, title }: { chatId: string; title: string }) {
  const { t } = useTranslation("chat");
  return (
    <Button
      asChild
      variant="outline"
      size="xs"
      className="mb-2 mt-1 min-w-0 max-w-full justify-start text-aux text-muted-foreground hover:text-foreground sm:max-w-sm"
    >
      <Link to={`/chat/${chatId}`} aria-label={t("concierge.openForwardedChat", { title })}>
        <Forward aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
        <ChevronRight aria-hidden />
      </Link>
    </Button>
  );
}
