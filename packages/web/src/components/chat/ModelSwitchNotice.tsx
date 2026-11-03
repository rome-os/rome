import { useTranslation } from "react-i18next";
import { modelDisplayName } from "@/lib/model-display";
import { cn } from "@/lib/utils";

/** A small centered line where the chat moved to another model. */
export function ModelSwitchNotice({ model, className }: { model: string; className?: string }) {
  const { t } = useTranslation("chat");
  return (
    <p role="note" className={cn("mb-4 text-center text-aux text-muted-foreground", className)}>
      {t("modelSwitch.notice", { model: modelDisplayName(model) })}
    </p>
  );
}
