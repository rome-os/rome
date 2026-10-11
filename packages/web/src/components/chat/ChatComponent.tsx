import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Chat, type SessionMessage } from "@/components/chat/Chat";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import { fetchRomeNewsDefinitions, getQuickEntries } from "@/config/quick-entries";
import type {
  ResolvedRomeNewsItem,
  RomeNewsDefinition,
} from "@rome-os/rome-web-components/news-item/schema";
import type { ChatComposerHandle } from "@/components/chat/ChatComposer";
import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { emitSessionsChanged, usePinSession, useSessionsChanged } from "@/lib/session-events";
import { listSessions } from "@/lib/chat-api";
import { useSettings } from "@/hooks/use-settings";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import type { AgentMention, ChatSession } from "@/lib/chat-types";

export type { SessionMessage };

export interface ChatComponentProps {
  sessionId?: string | null;
  onSessionCreated: (id: string) => void;
  onSessionNotFound?: () => void;
  onSessionMessage?: (message: SessionMessage) => void;
  initialProjectName?: string;
  initialAgentMention?: AgentMention | null;
  // Pre-fills the draft composer without sending — task text seeded
  // via navigateRome chat/new draft.
  initialDraftText?: string;
  // Pre-pins a skill chip on the draft composer without sending —
  // the structured counterpart of initialDraftText, seeded by the Skills app.
  initialSkillName?: string;
}

export function ChatComponent({
  sessionId,
  onSessionCreated,
  onSessionNotFound,
  onSessionMessage,
  initialProjectName,
  initialAgentMention,
  initialDraftText,
  initialSkillName,
}: ChatComponentProps) {
  const { i18n } = useTranslation("chat");

  const { data: settings } = useSettings();
  const coarsePointer = useCoarsePointer();
  const guardianName = (settings?.guardianName as string | undefined) ?? "";
  const mainAgentDisplayName =
    typeof settings?.agentName === "string" ? settings.agentName : undefined;

  const notifySessionsChanged = useCallback(() => {
    emitSessionsChanged();
  }, []);

  // One <Chat> spans a draft and the session its first send creates, so the
  // focused composer stays mounted through the navigation that send triggers
  // and a phone keeps its soft keyboard open. Any other session gets its own
  // instance, and so does every return to the draft.
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  if (sessionId !== previousSessionId) {
    setPreviousSessionId(sessionId);
    if (!sessionId && previousSessionId) {
      setDraftKey((key) => key + 1);
      setCreatedSessionId(null);
    }
  }
  const surfaceKey = !sessionId || sessionId === createdSessionId ? `draft-${draftKey}` : sessionId;
  // Queued before the host's own update, so the render that receives the new
  // sessionId already knows this surface created it and keeps the key.
  const handleSessionCreated = useCallback(
    (id: string) => {
      setCreatedSessionId(id);
      onSessionCreated(id);
    },
    [onSessionCreated],
  );

  const composerRef = useRef<ChatComposerHandle>(null);
  useEffect(() => {
    if (!sessionId && !coarsePointer) composerRef.current?.focus();
  }, [sessionId, coarsePointer]);

  // Seed the draft composer once per provided draft. insertText (vs. a
  // useState seed in the composer) also fixes up textarea height and cursor.
  const appliedDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialDraftText || sessionId) return;
    if (appliedDraftRef.current === initialDraftText) return;
    appliedDraftRef.current = initialDraftText;
    composerRef.current?.insertText(initialDraftText, { focus: !coarsePointer });
  }, [initialDraftText, sessionId, coarsePointer]);

  // Same once-per-value seeding for a structured skill selection — the chip
  // counterpart of the draft text.
  const appliedSkillRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSkillName || sessionId) return;
    if (appliedSkillRef.current === initialSkillName) return;
    appliedSkillRef.current = initialSkillName;
    composerRef.current?.setSkillSelection({ name: initialSkillName });
  }, [initialSkillName, sessionId]);

  const navigate = useNavigate();
  const location = useLocation();
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
  const handleSessionNotFound = useCallback(
    (missingSessionId: string) => {
      if (missingSessionId !== sessionId) return;
      if (onSessionNotFound) {
        onSessionNotFound();
        return;
      }
      navigate(hideSidebar ? "/chat?hideSidebar=1" : "/chat", { replace: true });
    },
    [sessionId, onSessionNotFound, navigate, hideSidebar],
  );
  const [cloudQuickEntryDefinitions, setCloudQuickEntryDefinitions] = useState<
    RomeNewsDefinition[]
  >([]);
  const quickEntries = useMemo(
    () => getQuickEntries(cloudQuickEntryDefinitions, i18n.language),
    [cloudQuickEntryDefinitions, i18n.language],
  );
  const [homeSessions, setHomeSessions] = useState<ChatSession[]>([]);
  const setSessionPinned = usePinSession();

  useEffect(() => {
    if (sessionId) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3_000);

    void fetchRomeNewsDefinitions(controller.signal)
      .then((definitions) => setCloudQuickEntryDefinitions(definitions))
      .catch(() => {
        // Rome News content is Cloud-owned. Keep the section hidden when the
        // feed is unavailable or invalid instead of carrying a second copy.
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sessionId]);

  const loadHomeData = useCallback(async () => {
    if (sessionId) return;
    try {
      setHomeSessions(await listSessions());
    } catch {
      // Keep the empty state usable when recent chats cannot be loaded.
    }
  }, [sessionId]);

  useEffect(() => {
    void loadHomeData();
  }, [loadHomeData]);

  useSessionsChanged(() => {
    void loadHomeData();
  });

  const pinnedChats = useMemo(
    () =>
      homeSessions
        .filter((session) => session.pinnedAt)
        .sort((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime())
        .map((session) => ({
          id: session.id,
          name: session.name,
          projectName: session.projectName || session.projectPath || "",
        })),
    [homeSessions],
  );

  const handleUnpinChat = useCallback(
    async (id: string) => {
      try {
        await setSessionPinned(id, false);
        setHomeSessions((sessions) =>
          sessions.map((session) => (session.id === id ? { ...session, pinnedAt: null } : session)),
        );
      } catch {
        // Keep the server-backed pin visible when the mutation fails.
      }
    },
    [setSessionPinned],
  );

  // Full URL the App Store sheet embeds when an app-store quick entry is picked;
  // null keeps the sheet closed.
  const [appStoreSrc, setAppStoreSrc] = useState<string | null>(null);

  const handleActivateQuickEntry = useCallback(
    (entry: ResolvedRomeNewsItem) => {
      switch (entry.type) {
        case "chat": {
          composerRef.current?.setSkillSelection(
            entry.skillName ? { name: entry.skillName } : null,
          );
          if (entry.mode === "start") {
            // Send immediately, carrying the composer's current selections.
            composerRef.current?.submit(entry.prompt, { skillName: entry.skillName });
          } else {
            composerRef.current?.insertText(entry.prompt);
          }
          return;
        }
        case "app-store":
          setAppStoreSrc(entry.url);
          return;
        case "link":
          if (entry.target === "external") {
            window.open(entry.href, "_blank", "noopener,noreferrer");
          } else {
            navigate(entry.href);
          }
          return;
      }
    },
    [navigate],
  );

  return (
    <>
      <Chat
        key={surfaceKey}
        sessionId={sessionId}
        mainAgentDisplayName={mainAgentDisplayName}
        onSessionsChanged={notifySessionsChanged}
        onSessionNotFound={handleSessionNotFound}
        onSessionMessage={onSessionMessage}
        onSessionCreated={handleSessionCreated}
        initialProjectName={initialProjectName}
        initialAgentMention={initialAgentMention}
        composerRef={composerRef}
        emptyState={
          <ChatEmptyState
            guardianName={guardianName}
            pinnedChats={pinnedChats}
            onOpenPinnedChat={(id) => navigate(`/chat/${id}`)}
            onUnpinChat={(id) => void handleUnpinChat(id)}
            quickEntries={quickEntries}
            onActivateQuickEntry={handleActivateQuickEntry}
          />
        }
      />
      <AppStoreSheet
        open={appStoreSrc !== null}
        src={appStoreSrc ?? undefined}
        onClose={() => setAppStoreSrc(null)}
        // No app list to refresh from the chat empty state; closing the sheet
        // after install is enough.
        onInstalled={() => setAppStoreSrc(null)}
      />
    </>
  );
}
