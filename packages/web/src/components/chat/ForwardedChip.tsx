import { ChevronRight, Forward } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * Where a forwarded report or a task's card came from, at its top: a quiet
 * label, as light as the thread label, that opens the task chat. A long
 * title is cut with an ellipsis.
 */
export function ForwardedChip({
  chatId,
  title,
  className,
}: {
  chatId: string;
  title: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <Link
      to={`/chat/${chatId}`}
      aria-label={t("concierge.openForwardedChat", { title })}
      className={cn(
        "mb-1 inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-4 text-aux text-muted-foreground/70 outline-1 outline-offset-1 outline-transparent transition-colors hover:text-muted-foreground focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none sm:max-w-sm [&_svg]:size-3 [&_svg]:shrink-0",
        className,
      )}
    >
      <Forward aria-hidden />
      <span className="min-w-0 truncate">{title}</span>
      <ChevronRight aria-hidden />
    </Link>
  );
}
