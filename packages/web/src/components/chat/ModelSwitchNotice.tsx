import { useTranslation } from "react-i18next";
import { modelDisplayName } from "@/lib/model-display";

/** A small centered line where the chat moved to another model. */
export function ModelSwitchNotice({ model }: { model: string }) {
  const { t } = useTranslation("chat");
  return (
    <p role="note" className="mb-4 text-center text-aux text-muted-foreground">
      {t("modelSwitch.notice", { model: modelDisplayName(model) })}
    </p>
  );
}
