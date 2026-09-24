import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { agentCatalogLabel } from "@/components/chat/composer/AgentMentionMenu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getWebchatDefaultAgent, listChatAgents, setWebchatDefaultAgent } from "@/lib/chat-api";
import type { AgentCatalogGroup } from "@/lib/chat-types";

const DEFAULT_AGENT_QUERY_KEY = ["chat", "default-agent"] as const;

/** Rome's main agent, as the Webchat catalog lists it in the Rome group. */
function findMainAgent(groups: AgentCatalogGroup[]) {
  const rome = groups.find((group) => group.ownerType === "core");
  const agent = rome?.agents.find((entry) => entry.localName === "main");
  return rome && agent ? { group: rome, agent } : null;
}

/**
 * Chooses which agent a new dashboard chat starts with. The options are
 * Webchat's loaded-agent catalog, grouped, labeled, and ordered as in the
 * `@`-agent chooser. A choice saves as soon as it is picked.
 */
export function WebchatDefaultAgentSetting() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const defaultAgent = useQuery({
    queryKey: DEFAULT_AGENT_QUERY_KEY,
    queryFn: getWebchatDefaultAgent,
  });
  const catalog = useQuery({ queryKey: ["chat", "agents"], queryFn: listChatAgents });
  const save = useMutation({
    mutationFn: setWebchatDefaultAgent,
    onSuccess: (next) => queryClient.setQueryData(DEFAULT_AGENT_QUERY_KEY, next),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("advanced.webchatDefaultAgent.saveFailed"),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: DEFAULT_AGENT_QUERY_KEY }),
  });

  const groups = catalog.data ?? [];
  const main = findMainAgent(groups);
  const effective = defaultAgent.data?.effective;
  const selectedName = effective === "main" ? main?.agent.name : effective;
  const selectedGroup = groups.find((group) =>
    group.agents.some((agent) => agent.name === selectedName),
  );
  const selectedAgent = selectedGroup?.agents.find((agent) => agent.name === selectedName);
  const savedUnavailable =
    defaultAgent.data?.saved != null && defaultAgent.data.saved.agentName !== effective;

  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel>{t("advanced.webchatDefaultAgent.title")}</FormRowLabel>
        <FormRowDescription>
          {savedUnavailable
            ? t("advanced.webchatDefaultAgent.savedUnavailable")
            : t("advanced.webchatDefaultAgent.description")}
        </FormRowDescription>
      </FormRowHeading>
      <FormRowControl>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("advanced.webchatDefaultAgent.title")}
              disabled={!defaultAgent.data || !catalog.data || save.isPending}
            >
              {selectedGroup && selectedAgent
                ? `${selectedGroup.label} · ${agentCatalogLabel(selectedAgent)}`
                : t("advanced.webchatDefaultAgent.loading")}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
            <DropdownMenuRadioGroup
              value={selectedName}
              onValueChange={(agentName) => save.mutate(agentName)}
            >
              {groups.map((group) => (
                <DropdownMenuGroup key={group.ownerId}>
                  <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                  {group.agents.map((agent) => (
                    <DropdownMenuRadioItem key={agent.name} value={agent.name}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{agentCatalogLabel(agent)}</span>
                        {agent.description && (
                          <span className="truncate text-aux text-muted-foreground">
                            {agent.description}
                          </span>
                        )}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </FormRowControl>
    </FormRow>
  );
}
