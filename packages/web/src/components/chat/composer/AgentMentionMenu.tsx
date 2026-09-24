import { forwardRef, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

function tokensMatch(haystack: string, query: string): boolean {
  if (!query) return true;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

// Filter rule: keep an app if its id/label matches the query, OR if any of
// its agents match. When the app itself matched, we keep all of its agents
// in the right panel; otherwise we keep only the matching subset. This is
// what "cross-level filter" means in the UI — typing `@expl` narrows the
// left panel to apps that own an `explore`-like agent.
function applyFilter(
  groups: AgentCatalogGroup[],
  query: string,
  fallbackDescription: (count: number) => string,
): Array<PickerGroup<AgentCatalogEntry>> {
  const out: Array<PickerGroup<AgentCatalogEntry>> = [];
  for (const group of groups) {
    const appMatches =
      !query || tokensMatch(group.ownerId, query) || tokensMatch(group.label, query);
    const agentMatches = appMatches
      ? group.agents
      : group.agents.filter(
          (agent) =>
            tokensMatch(agent.localName ?? agent.name, query) ||
            tokensMatch(agent.name, query) ||
            tokensMatch(`${group.ownerId}/${agent.localName ?? agent.name}`, query),
        );
    if (agentMatches.length === 0) continue;
    out.push({
      ownerId: group.ownerId,
      label: group.label,
      description: group.description || fallbackDescription(agentMatches.length),
      iconUrl: group.iconUrl,
      items: agentMatches,
    });
  }
  return out;
}

/** An agent's label in every Webchat agent chooser. */
export function agentCatalogLabel(agent: AgentCatalogEntry): string {
  return agent.localName ?? agent.name;
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
      () => applyFilter(groups ?? [], query, (count) => t("agentMention.agentCount", { count })),
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
        renderItemLabel={agentCatalogLabel}
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
