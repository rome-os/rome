import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { useTranslation } from "react-i18next";
import { modelDisplayName } from "@/lib/model-display";
import { cn } from "@/lib/utils";

/** A small centered line where the chat moved to another model. */
export function ModelSwitchNotice({
  model,
  quota,
  className,
}: {
  model: string;
  quota?: QuotaSwitchPart;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <p role="note" className={cn("mb-4 text-center text-aux text-muted-foreground", className)}>
      {quota
        ? t("modelSwitch.quota", {
            from: quota.from === "openai" ? "Codex" : "Claude",
            to: quota.to === "openai" ? "Codex" : "Claude",
          })
        : t("modelSwitch.notice", { model: modelDisplayName(model) })}
    </p>
  );
}
