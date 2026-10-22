import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Chat, type SessionMessage } from "@/components/chat/Chat";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import { fetchRomeNewsDefinitions, getQuickEntries, romeNewsConfig } from "@/config/quick-entries";
import type {
  ResolvedRomeNewsItem,
  RomeNewsDefinition,
} from "@rome-os/rome-web-components/news-item/schema";
import type { ChatComposerHandle } from "@/components/chat/ChatComposer";
import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { emitSessionsChanged } from "@/lib/session-events";
import { useSettings } from "@/hooks/use-settings";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import type { AgentMention } from "@/lib/chat-types";

export type { SessionMessage };

// The home's last known layout, so a reload starts where the previous visit
// ended instead of moving the composer once its sessions arrive.
export const GREETING_ONLY_HOME_KEY = "rome.chat.greeting-only-home";

function readGreetingOnlyHome(): boolean {
  try {
    return window.localStorage.getItem(GREETING_ONLY_HOME_KEY) !== "false";
  } catch {
    return true;
  }
}

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

  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (sessionId) return;
    const hasTextOrSkill = initialDraftText !== undefined || initialSkillName !== undefined;
    if (hasTextOrSkill) {
      // A skill-only entry (the Skills app with a blank task) keeps the unsent text.
      if (initialDraftText !== undefined)
        composerRef.current?.insertText(initialDraftText, { focus: !coarsePointer });
      composerRef.current?.setSkillSelection(initialSkillName ? { name: initialSkillName } : null);
    }
    const state = { ...location.state };
    // FreeGrid's effect consumes this render's widgets even after history state is stripped.
    const prefillKeys = ["draft", "skill", "projectPath", "agentMention", "agentName", "widgets"];
    if (!prefillKeys.some((key) => key in state)) return;
    for (const key of prefillKeys) delete state[key];
    navigate(location.pathname + location.search, {
      replace: true,
      state: Object.keys(state).length ? state : null,
    });
  }, [
    sessionId,
    initialDraftText,
    initialSkillName,
    initialProjectName,
    initialAgentMention,
    coarsePointer,
    navigate,
    location.pathname,
    location.search,
    location.state,
  ]);

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
  const [newsSettled, setNewsSettled] = useState(!romeNewsConfig.enabled);

  useEffect(() => {
    if (sessionId || !romeNewsConfig.enabled) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3_000);

    void fetchRomeNewsDefinitions(controller.signal)
      .then((definitions) => setCloudQuickEntryDefinitions(definitions))
      .catch(() => {
        // Rome News content is Cloud-owned. Keep the section hidden when the
        // feed is unavailable or invalid instead of carrying a second copy.
      })
      .finally(() => {
        window.clearTimeout(timeout);
        setNewsSettled(true);
      });

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sessionId]);

  // Center the greeting with the composer when the home has nothing else to
  // show. Until Rome News settles, keep the last known layout.
  const loadedGreetingOnly = quickEntries.length === 0;
  const [rememberedGreetingOnly] = useState(readGreetingOnlyHome);
  const greetingOnlyHome = newsSettled ? loadedGreetingOnly : rememberedGreetingOnly;
  useEffect(() => {
    if (!newsSettled) return;
    try {
      window.localStorage.setItem(GREETING_ONLY_HOME_KEY, String(loadedGreetingOnly));
    } catch {
      // Storage can be unavailable; the layout then just starts centered.
    }
  }, [newsSettled, loadedGreetingOnly]);

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
        centerDraftComposer={greetingOnlyHome}
        emptyState={
          <ChatEmptyState
            guardianName={guardianName}
            quickEntries={quickEntries}
            onActivateQuickEntry={handleActivateQuickEntry}
            hugComposer={greetingOnlyHome}
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
