import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { prettyAgentName } from "@/lib/agent-name";
import type { AgentMention } from "@/lib/chat-types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerChip } from "./ComposerChip";

export interface AgentMentionChipProps {
  mention: AgentMention;
  pinned: boolean;
  // The × shows whenever this is provided; the caller decides what it does
  // (clear a draft mention, or cancel a live handoff).
  onRemove?: () => void;
  removeLabel?: string;
}

export function AgentMentionChip({
  mention,
  pinned,
  onRemove,
  removeLabel,
}: AgentMentionChipProps) {
  const { t } = useTranslation("chat");
  const agent = mention.label ?? prettyAgentName(mention.agentName);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ComposerChip
            icon={
              mention.iconUrl ? (
                <img src={mention.iconUrl} alt="" className="size-3.5 shrink-0 rounded-4" />
              ) : (
                <RomeLogo aria-hidden="true" className="size-3.5 shrink-0" />
              )
            }
            onRemove={onRemove}
            removeLabel={removeLabel ?? t("agentMention.remove")}
          >
            {agent}
          </ComposerChip>
        </TooltipTrigger>
        <TooltipContent>
          {t(pinned ? "agentMention.pinnedTitle" : "agentMention.draftTitle", { agent })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
