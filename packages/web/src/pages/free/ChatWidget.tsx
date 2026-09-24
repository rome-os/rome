import { useCallback, useRef } from "react";
import { ChatComponent, type SessionMessage } from "@/components/chat/ChatComponent";
import { detectAppInstalls } from "@/lib/chat-helpers";
import { extractFilePathsFromText, isProjectPath } from "@/lib/extract-file-paths";
import type { AgentMention } from "@/lib/chat-types";
import type { TraceBlockDto } from "@rome/api-types/trace-segments";
import { useWorkspaceEventBus } from "./workspace-event-bus";
import { useWorkspaceStore } from "./workspace-store";

function extractProjectPathsFromBlocks(blocks: TraceBlockDto[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const block of blocks) {
    if (block.type !== "text") continue;
    const paths = extractFilePathsFromText({
      type: "text",
      content: block.content,
    });
    for (const p of paths) {
      if (isProjectPath(p) && !seen.has(p)) {
        seen.add(p);
        result.push(p);
      }
    }
  }
  return result;
}

interface ChatWidgetProps {
  sessionId?: string;
  onSessionChosen: (sessionId: string) => void;
  initialProjectName?: string;
  initialAgentMention?: AgentMention | null;
  defaultAgentSeed?: { draftKey: string; mention: AgentMention } | null;
  initialDraftText?: string;
  initialSkillName?: string;
}

export function ChatWidget({
  sessionId,
  onSessionChosen,
  initialProjectName,
  initialAgentMention,
  defaultAgentSeed,
  initialDraftText,
  initialSkillName,
}: ChatWidgetProps) {
  const store = useWorkspaceStore();
  const eventBus = useWorkspaceEventBus();
  const emittedAppInstallsRef = useRef(new Set<string>());
  const emittedProjectOpenRef = useRef(false);
  const lastTurnIdRef = useRef<string | null>(null);

  const handleSessionMessage = useCallback(
    (msg: SessionMessage) => {
      store.set("activeTurnId", msg.turnId);
      store.set("activeSessionId", msg.turnId ? msg.sessionId : null);

      if (msg.turnId !== lastTurnIdRef.current) {
        lastTurnIdRef.current = msg.turnId;
        emittedProjectOpenRef.current = false;
        emittedAppInstallsRef.current.clear();
        // Reset the follow target only when a *new* turn begins (non-null
        // turnId) — not on teardown (turnId -> null). Clearing on teardown
        // would null `followTargetPath` right after the final link is
        // published, cancelling ProjectsWidget's in-flight resolve before the
        // target is ever selected. Keeping it lets the last artifact stay selected
        // until the next turn links something (or replaces it mid-turn).
        if (msg.turnId) store.set("followTargetPath", null);
      }

      const seg = msg.segment;
      if (!seg) return;

      // App installs come from tool activity, which only lives in run segments.
      if (seg.kind === "run") {
        const installs = detectAppInstalls(seg.blocks);
        for (const evt of installs) {
          if (!emittedAppInstallsRef.current.has(evt.appId)) {
            emittedAppInstallsRef.current.add(evt.appId);
            eventBus?.emit("app:installed", evt);
          }
        }
      }

      // Files the agent links in its own message drive both the projects panel
      // and file-following. We source them here, off the authoritative chat
      // stream ChatWidget already consumes, rather than from a second per-turn
      // SSE subscription: that stream is fully read (including the terminal text
      // segment) before the turn tears down, so the navigation signal can't be
      // lost to an aborted-mid-flight stream. The link arrives as a standalone
      // text "block" segment, so check both segment shapes.
      const blocks = seg.kind === "run" ? seg.blocks : [seg.block];
      const paths = extractProjectPathsFromBlocks(blocks);
      if (paths.length === 0) return;

      // Open the panel once per turn...
      if (!emittedProjectOpenRef.current) {
        emittedProjectOpenRef.current = true;
        eventBus?.emit("projects:opened", { paths });
      }

      // ...and follow the most recent artifact — the last link in the message,
      // not the first (a reply can present several files).
      store.set("followTargetPath", paths[paths.length - 1]);
    },
    [store, eventBus],
  );

  return (
    <ChatComponent
      sessionId={sessionId}
      onSessionCreated={onSessionChosen}
      onSessionMessage={handleSessionMessage}
      initialProjectName={initialProjectName}
      initialAgentMention={initialAgentMention}
      defaultAgentSeed={defaultAgentSeed}
      initialDraftText={initialDraftText}
      initialSkillName={initialSkillName}
    />
  );
}
