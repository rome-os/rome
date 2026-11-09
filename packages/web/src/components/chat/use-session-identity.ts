import { useEffect, useRef, useState } from "react";
import type { AgentMention, ChatSession } from "@/lib/chat-types";
import { CONCIERGE_AGENT_ID, TASK_CHAT_TRIGGER_KIND } from "@/hooks/use-concierge";
import { getSession, listChatAgents } from "@/lib/chat-api";
import { artifactOwnerId } from "@/lib/artifact-name";
import { prettyAgentName } from "@/lib/agent-name";
import { usePresentationMode } from "@/lib/presentation-mode";
import { useSessionsChanged } from "@/lib/session-events";

/**
 * Whether a chat offers the fork button: a fork chat always does, and
 * otherwise only a common chat, not a Concierge chat or a task chat.
 */
export function isForkableChat(
  session: Pick<ChatSession, "parentSessionId" | "agentName" | "triggerKind">,
): boolean {
  if (session.parentSessionId) return true;
  return session.agentName !== CONCIERGE_AGENT_ID && session.triggerKind !== TASK_CHAT_TRIGGER_KIND;
}

export interface SessionIdentity {
  /**
   * True while an existing session's metadata is being fetched (a session id is
   * set but its first fetch has not settled). False for a draft with no id.
   */
  loading: boolean;
  /** The session's display name, or null while loading / unnamed. */
  sessionName: string | null;
  model: string | null;
  /** The model picked for this chat, or null when it follows its pin. */
  largeModelSelection: string | null;
  /** A fork chat promoted to a chat: it still runs on its branch. */
  isForkChat: boolean;
  /** Provider-reported effort of the session's last successful turn, or null when unknown. */
  reasoningEffort: string | null;
  /** The session's locked agent, resolved to its owning app's label + icon. */
  pinnedAgentMention: AgentMention | null;
  /** ISO timestamp when the session was archived, or null when not archived. */
  archivedAt: string | null;
  /**
   * Whether a turn of this chat can be forked: in a common chat or a fork
   * chat, and not in a main, topic or task chat.
   */
  forkable: boolean;
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
  const [largeModelSelection, setLargeModelSelection] = useState<string | null>(null);
  const [isForkChat, setIsForkChat] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [pinnedAgentMention, setPinnedAgentMention] = useState<AgentMention | null>(null);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [forkable, setForkable] = useState(false);
  // The session id whose first fetch has settled (success or failure). Keyed by
  // id so switching sessions is "loading" again with no reset-effect flash.
  const [settledSessionId, setSettledSessionId] = useState<string | null>(null);

  useEffect(() => {
    sessionGeneration.current += 1;
    if (!sessionId) {
      setPinnedAgentMention(null);
      setModel(null);
      setLargeModelSelection(null);
      setIsForkChat(false);
      setReasoningEffort(null);
      setSessionName(null);
      setArchivedAt(null);
      setForkable(false);
      return;
    }
    setModel(null);
    setLargeModelSelection(null);
    setIsForkChat(false);
    setReasoningEffort(null);
    // Drop the previous session's identity so it never shows under the new id.
    setSessionName(null);
    setPinnedAgentMention(null);
    let cancelled = false;
    (async () => {
      try {
        const [session, groups] = await Promise.all([
          getSession(sessionId),
          listChatAgents().catch(() => []),
        ]);
        if (cancelled) return;
        setSettledSessionId(sessionId);
        setSessionName(session?.name ?? null);
        setModel(session?.model ?? null);
        setLargeModelSelection(session?.largeModelSelection ?? null);
        setIsForkChat(!!session?.parentSessionId);
        setReasoningEffort(session?.reasoningEffort ?? null);
        setArchivedAt(session?.archivedAt ?? null);
        setForkable(!!session && isForkableChat(session));
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
          setSettledSessionId(sessionId);
          setModel(null);
          setLargeModelSelection(null);
          setIsForkChat(false);
          setReasoningEffort(null);
          setSessionName(null);
          setPinnedAgentMention(null);
          setArchivedAt(null);
          setForkable(false);
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
        setLargeModelSelection(session?.largeModelSelection ?? null);
        setIsForkChat(!!session?.parentSessionId);
        setReasoningEffort(session?.reasoningEffort ?? null);
        setArchivedAt(session?.archivedAt ?? null);
        setForkable(!!session && isForkableChat(session));
      } catch {
        // Best effort; the next mount / event reconciles.
      }
    })();
  });

  return {
    loading: !!sessionId && settledSessionId !== sessionId,
    sessionName,
    model,
    largeModelSelection,
    isForkChat,
    reasoningEffort,
    pinnedAgentMention: presentationMode ? null : pinnedAgentMention,
    archivedAt,
    forkable,
  };
}
