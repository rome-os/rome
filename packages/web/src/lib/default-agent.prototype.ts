// PROTOTYPE (webchat-default-agent). Throwaway; not for merge.
import type { AgentCatalogGroup, AgentMention } from "@/lib/chat-types";

export interface DefaultAgentState {
  saved: { agentName: string; ownerAppId: string } | null;
  savedLoaded: boolean;
  effective: string;
}

export async function fetchDefaultAgent(): Promise<DefaultAgentState> {
  const res = await fetch("/api/chat/default-agent", { credentials: "include" });
  if (!res.ok) throw new Error(`default-agent ${res.status}`);
  return (await res.json()) as DefaultAgentState;
}

export async function saveDefaultAgent(agentName: string | null): Promise<void> {
  const res = await fetch("/api/chat/default-agent", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "save failed");
}

export type DraftSeedDecision =
  | { settled: true; mention: AgentMention | null; reason: string }
  | { settled: false; reason: string };

/**
 * THE seeding condition. A blank new-chat draft gets the saved default only when
 * nothing explicit names an agent. Callers latch the first settled decision per
 * draft, so refetches, re-renders, a swap, or the guardian removing the chip
 * never bring the default back into that draft.
 */
export function decideDraftDefaultAgentSeed(input: {
  sessionId: string | undefined;
  entryPointMention: AgentMention | null;
  defaultAgent: DefaultAgentState | undefined;
  catalog: AgentCatalogGroup[] | undefined;
}): DraftSeedDecision {
  if (input.sessionId) return { settled: true, mention: null, reason: "existing-session" };
  if (input.entryPointMention) return { settled: true, mention: null, reason: "entry-point-agent" };
  if (!input.defaultAgent || !input.catalog) return { settled: false, reason: "loading" };
  const name = input.defaultAgent.effective;
  if (name === "main") return { settled: true, mention: null, reason: "default-is-main" };
  const group = input.catalog.find((g) => g.agents.some((a) => a.name === name));
  if (!group) return { settled: true, mention: null, reason: "default-not-in-catalog" };
  return {
    settled: true,
    mention: {
      appId: group.ownerId,
      appLabel: group.label,
      agentName: name,
      iconUrl: group.iconUrl,
    },
    reason: "seeded-saved-default",
  };
}
