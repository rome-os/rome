import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { ModelProviderIcon } from "@/components/brand-icons/ai-tool-icons";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { COARSE_POINTER_QUERY, matchesMediaQuery } from "@/lib/media-query";
import { modelDisplayName, reasoningEffortDisplayName } from "@/lib/model-display";

/**
 * The chat header avatar. When the session has pinned a model, the avatar
 * carries the model vendor's mark as a corner badge, and the model name and
 * last turn's effort show on hover, or on tap where there is no hover.
 */
export function SessionAvatar({
  iconUrl,
  label,
  model,
  reasoningEffort,
}: {
  iconUrl?: string | null;
  label?: string | null;
  model: string | null | undefined;
  reasoningEffort?: string | null;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);

  const avatar = <AgentAvatar iconUrl={iconUrl} label={label} size="sm" className="shrink-0" />;
  if (!model) return avatar;

  // The accessible name keeps the raw ids; the tooltip shows the friendly name.
  const description = reasoningEffort
    ? t("navbar.sessionModelWithEffort", { model, effort: reasoningEffort })
    : t("navbar.sessionModel", { model });
  const name = modelDisplayName(model);
  const summary = reasoningEffort
    ? `${name} · ${reasoningEffortDisplayName(reasoningEffort)}`
    : name;

  // A tooltip trigger closes on click. Without hover, a tap is the only way
  // to open it, so a tap opens it instead; a tap outside closes it.
  const openOnTap = (event: MouseEvent) => {
    if (!matchesMediaQuery(COARSE_POINTER_QUERY)) return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild onClick={openOnTap}>
          <button
            type="button"
            aria-label={description}
            className="relative shrink-0 rounded-8 outline-1 outline-offset-0 outline-transparent transition-colors focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {avatar}
            <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
              <ModelProviderIcon model={model} className="size-2.5" />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {summary}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
