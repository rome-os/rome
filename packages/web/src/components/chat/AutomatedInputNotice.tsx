import type { SystemInputSource } from "@rome/api-types/trace-segments";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * A faint centered line where a routine, an app or another agent sent
 * something into a Concierge chat. What it sent is the Concierge's input,
 * kept in the turn's trace; the chat shows only who sent it, and then what
 * the Concierge says (docs/domains/chats.md#concierge-chat).
 */
export function AutomatedInputNotice({
  source,
  className,
}: {
  source: SystemInputSource;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const kind = t(`automatedInput.kinds.${source.type}`);
  return (
    <p
      role="note"
      data-automated-input={source.type}
      className={cn("text-center text-aux text-muted-foreground opacity-70", className)}
    >
      {source.name ? t("automatedInput.named", { kind, name: source.name }) : kind}
    </p>
  );
}
