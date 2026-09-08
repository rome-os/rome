import { useEffect, useRef, useState } from "react";
import type { AgentMention } from "@/lib/chat-types";
import { getSession, listChatAgents } from "@/lib/chat-api";
import { artifactOwnerId } from "@/lib/artifact-name";
import { prettyAgentName } from "@/lib/agent-name";
import { usePresentationMode } from "@/lib/presentation-mode";
import { useSessionsChanged } from "@/lib/session-events";

export interface SessionIdentity {
  /** The session's display name, or null while loading / unnamed. */
  sessionName: string | null;
  model: string | null;
  /** The session's locked agent, resolved to its owning app's label + icon. */
  pinnedAgentMention: AgentMention | null;
  /** ISO timestamp when the session was archived, or null when not archived. */
  archivedAt: string | null;
  /** ISO timestamp when the session was pinned, or null when not pinned. */
  pinnedAt: string | null;
}

/**
 * Resolve a chat session's display identity — its name and the locked agent's
 * app label / icon. The session row only stores the global agent name, so we hit
 * /api/chat/agents to recover the app's display label; failures fall back to the
 * agent id. Shared by the desktop chat navbar (Chat) and the mobile header bar
 * (FreeGrid) so both render the same identity from one place.
 *
 * This hook is also the single choke point for presentation mode: while it is
 * on, the pinned-agent mention is reported as null, so every consumer (navbar,
 * per-turn identity, composer chip, mobile header) falls back to the main
 * assistant's rendering without knowing the mode exists.
 */
export function useSessionIdentity(sessionId: string | null | undefined): SessionIdentity {
  const presentationMode = usePresentationMode();
  const sessionGeneration = useRef(0);
  const [model, setModel] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [pinnedAgentMention, setPinnedAgentMention] = useState<AgentMention | null>(null);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [pinnedAt, setPinnedAt] = useState<string | null>(null);

  useEffect(() => {
    sessionGeneration.current += 1;
    if (!sessionId) {
      setPinnedAgentMention(null);
      setModel(null);
      setSessionName(null);
      setArchivedAt(null);
      setPinnedAt(null);
      return;
    }
    setModel(null);
    let cancelled = false;
    (async () => {
      try {
        const [session, groups] = await Promise.all([
          getSession(sessionId),
          listChatAgents().catch(() => []),
        ]);
        if (cancelled) return;
        setSessionName(session?.name ?? null);
        setModel(session?.model ?? null);
        setArchivedAt(session?.archivedAt ?? null);
        setPinnedAt(session?.pinnedAt ?? null);
        const agentName = session?.agentName ?? null;
        if (!agentName) {
          setPinnedAgentMention(null);
          return;
        }
        let appId = artifactOwnerId(agentName) ?? "";
        let appLabel = prettyAgentName(appId || agentName);
        let iconUrl: string | null = null;
        const owner = groups.find((g) => g.agents.some((a) => a.name === agentName));
        if (owner) {
          appId = owner.ownerId;
          appLabel = owner.label;
          iconUrl = owner.iconUrl;
        }
        if (!cancelled) {
          setPinnedAgentMention({ appId, appLabel, agentName, iconUrl });
        }
      } catch {
        if (!cancelled) {
          setModel(null);
          setSessionName(null);
          setPinnedAgentMention(null);
          setArchivedAt(null);
          setPinnedAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      sessionGeneration.current += 1;
    };
  }, [sessionId]);

  // Keep the archived flag (and name) in sync when EITHER archive entry point
  // mutates sessions — the navbar handlers here or the sidebar's row actions,
  // which both emit the sessions-changed event. Without this, archiving the
  // currently open chat from the sidebar would leave this view editable until
  // the next send hit the server's 409. Refetch only the session (not agents,
  // which don't change on archive) to keep the listener cheap.
  useSessionsChanged(() => {
    if (!sessionId) return;
    const generation = sessionGeneration.current;
    void (async () => {
      try {
        const session = await getSession(sessionId);
        if (generation !== sessionGeneration.current) return;
        setSessionName(session?.name ?? null);
        setModel(session?.model ?? null);
        setArchivedAt(session?.archivedAt ?? null);
        setPinnedAt(session?.pinnedAt ?? null);
      } catch {
        // Best effort; the next mount / event reconciles.
      }
    })();
  });

  return {
    sessionName,
    model,
    pinnedAgentMention: presentationMode ? null : pinnedAgentMention,
    archivedAt,
    pinnedAt,
  };
}
