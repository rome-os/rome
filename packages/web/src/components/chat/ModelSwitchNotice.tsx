import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { useTranslation } from "react-i18next";
import { useProviderName } from "@/components/default-provider";
import { modelFamily } from "@/lib/chat-constants";
import { modelDisplayName } from "@/lib/model-display";
import { cn } from "@/lib/utils";

/**
 * A small centered line where the chat moved to another model. A move to
 * another provider names the provider ("Switched to Claude"); a move within
 * one names the model. `quota` is the older automatic switch Rome wrote into
 * the chat before it stopped moving chats on its own.
 */
export function ModelSwitchNotice({
  model,
  fromModel,
  quota,
  className,
}: {
  model: string;
  /** The model of the turn before, when known. */
  fromModel?: string;
  quota?: QuotaSwitchPart;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const providerName = useProviderName();
  const to = modelFamily(model);
  const from = fromModel ? modelFamily(fromModel) : null;
  return (
    <p role="note" className={cn("mb-4 text-center text-aux text-muted-foreground", className)}>
      {quota
        ? t(`modelSwitch.${quota.from === quota.to ? "model_limit" : (quota.reason ?? "quota")}`, {
            from: quota.from === "openai" ? "Codex" : "Claude",
            to: quota.to === "openai" ? "Codex" : "Claude",
            fromModel: modelDisplayName(quota.fromModel ?? ""),
            toModel: modelDisplayName(quota.model),
          })
        : to && from && to !== from
          ? t("modelSwitch.notice", { model: providerName(to) })
          : t("modelSwitch.notice", { model: modelDisplayName(model) })}
    </p>
  );
}
