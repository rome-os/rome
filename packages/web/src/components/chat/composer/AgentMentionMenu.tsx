import { forwardRef, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterAgentCatalog } from "@/lib/agent-catalog-filter";
import { listChatAgents } from "@/lib/chat-api";
import type { AgentCatalogEntry, AgentCatalogGroup, AgentMention } from "@/lib/chat-types";
import {
  AppGroupedPickerMenu,
  type AppGroupedPickerMenuHandle,
  type PickerGroup,
} from "./AppGroupedPickerMenu";

export type AgentMentionMenuHandle = AppGroupedPickerMenuHandle;

export interface AgentMentionMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Filter string (the text the user typed after `@` in the textarea).
  query: string;
  onSelect: (mention: AgentMention) => void;
  // Rendered as the popover anchor — typically a wrapper around the textarea.
  anchor: React.ReactNode;
}

function toPickerGroups(
  groups: AgentCatalogGroup[],
  fallbackDescription: (count: number) => string,
): Array<PickerGroup<AgentCatalogEntry>> {
  return groups.map((group) => ({
    ownerId: group.ownerId,
    label: group.label,
    description: group.description || fallbackDescription(group.agents.length),
    iconUrl: group.iconUrl,
    items: group.agents,
  }));
}

/**
 * Autocomplete for `@<app>/<agent>` mentions: an AppGroupedPickerMenu adapter
 * over `GET /api/chat/agents` (already grouped + ordered by the server).
 * Selecting emits an AgentMention for the composer chip.
 */
export const AgentMentionMenu = forwardRef<AgentMentionMenuHandle, AgentMentionMenuProps>(
  function AgentMentionMenu({ open, onOpenChange, query, onSelect, anchor }, ref) {
    const { t } = useTranslation("chat");
    const [groups, setGroups] = useState<AgentCatalogGroup[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fetch on open, but only cache success: a failed load leaves `groups`
    // null so the next open retries instead of pinning a false-empty catalog.
    useEffect(() => {
      if (!open || groups !== null) return;
      let cancelled = false;
      listChatAgents()
        .then((data) => {
          if (cancelled) return;
          setGroups(data);
          setError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setError(t("agentMention.loadFailed"));
        });
      return () => {
        cancelled = true;
      };
    }, [open, groups, t]);

    const filtered = useMemo(
      () =>
        toPickerGroups(filterAgentCatalog(groups ?? [], query), (count) =>
          t("agentMention.agentCount", { count }),
        ),
      [groups, query, t],
    );

    return (
      <AppGroupedPickerMenu<AgentCatalogEntry>
        ref={ref}
        open={open}
        onOpenChange={onOpenChange}
        query={query}
        anchor={anchor}
        title={t("agentMention.menuTitle")}
        loading={groups === null}
        loadingText={t("agentMention.loading")}
        error={error}
        emptyText={
          (groups ?? []).length === 0 ? t("agentMention.empty") : t("agentMention.noMatch")
        }
        pickGroupText={t("agentMention.pickApp")}
        groups={filtered}
        getItemKey={(agent) => agent.name}
        renderItemLabel={(agent) => agent.localName ?? agent.name}
        getItemDescription={(agent) => agent.description}
        onSelect={(group, agent) =>
          onSelect({
            appId: group.ownerId,
            appLabel: group.label,
            agentName: agent.name,
            iconUrl: group.iconUrl,
          })
        }
      />
    );
  },
);
