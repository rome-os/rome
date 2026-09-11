import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Chat, type SessionMessage } from "@/components/chat/Chat";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import {
  fetchRomeNewsDefinitions,
  getQuickEntries,
  type QuickEntry,
  type QuickEntryDefinition,
} from "@/config/quick-entries";
import {
  ChatComposer,
  type ChatComposerHandle,
  type ChatComposerSendControls,
  type ChatComposerSnapshot,
} from "@/components/chat/ChatComposer";
import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { emitSessionsChanged, usePinSession, useSessionsChanged } from "@/lib/session-events";
import {
  ChatApiError,
  createSession as apiCreateSession,
  listSessions,
  postSessionTurn,
} from "@/lib/chat-api";
import { useSettings } from "@/hooks/use-settings";
import { dataTransferHasFiles, extractFilesFromDataTransfer } from "@/lib/clipboard-files";
import type { AgentMention, ChatErrorNotice, ChatSession } from "@/lib/chat-types";
import {
  snapshotWorkspaceForSend,
  useWorkspaceContextRegistry,
} from "@/pages/free/workspace-context";

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
  // `null` when the chat is mounted outside the workspace shell;
  // the draft-send path simply skips workspace injection in that case.
  const workspaceContextRegistry = useWorkspaceContextRegistry();
  const { t, i18n } = useTranslation("chat");

  const { data: settings } = useSettings();
  const guardianName = (settings?.guardianName as string | undefined) ?? "";
  const mainAgentDisplayName =
    typeof settings?.agentName === "string" ? settings.agentName : undefined;

  const notifySessionsChanged = useCallback(() => {
    emitSessionsChanged();
  }, []);

  const draftComposerRef = useRef<ChatComposerHandle>(null);
  const draftDragDepthRef = useRef(0);
  const [draftStreamError, setDraftStreamError] = useState<string | ChatErrorNotice | null>(null);
  const [isDraggingDraftFiles, setIsDraggingDraftFiles] = useState(false);
  const pendingDraftRef = useRef<{
    sessionId: string;
    projectPath: string;
    largeModelSelection?: string;
    agentName?: string;
  } | null>(null);
  const draftSendInFlightRef = useRef(false);

  // Seed the draft composer once per provided draft. insertText (vs. a
  // useState seed in the composer) also fixes up textarea height and cursor.
  const appliedDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialDraftText || sessionId) return;
    if (appliedDraftRef.current === initialDraftText) return;
    appliedDraftRef.current = initialDraftText;
    draftComposerRef.current?.insertText(initialDraftText);
  }, [initialDraftText, sessionId]);

  // Same once-per-value seeding for a structured skill selection — the chip
  // counterpart of the draft text.
  const appliedSkillRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSkillName || sessionId) return;
    if (appliedSkillRef.current === initialSkillName) return;
    appliedSkillRef.current = initialSkillName;
    draftComposerRef.current?.setSkillSelection({ name: initialSkillName });
  }, [initialSkillName, sessionId]);

  const navigate = useNavigate();
  const [cloudQuickEntryDefinitions, setCloudQuickEntryDefinitions] = useState<
    QuickEntryDefinition[]
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
    (entry: QuickEntry) => {
      switch (entry.type) {
        case "chat": {
          draftComposerRef.current?.setSkillSelection(
            entry.skillName ? { name: entry.skillName } : null,
          );
          if (entry.mode === "start") {
            // Send immediately, carrying the composer's current selections.
            draftComposerRef.current?.submit(entry.prompt, { skillName: entry.skillName });
          } else {
            draftComposerRef.current?.insertText(entry.prompt);
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

  const handleDraftSend = useCallback(
    async (snapshot: ChatComposerSnapshot, controls: ChatComposerSendControls) => {
      if (draftSendInFlightRef.current) return;
      draftSendInFlightRef.current = true;
      setDraftStreamError(null);

      try {
        const cached = pendingDraftRef.current;
        const requestedAgentName = snapshot.agentMention?.agentName;
        const cacheUsable =
          cached !== null &&
          cached.projectPath === snapshot.projectPath &&
          cached.largeModelSelection === snapshot.largeModelSelection &&
          cached.agentName === requestedAgentName;
        if (cached && !cacheUsable) {
          pendingDraftRef.current = null;
        }

        let newSessionId = cacheUsable ? cached.sessionId : null;
        if (!newSessionId) {
          try {
            const created = await apiCreateSession({
              name: t("sidebar.newChat"),
              personaId: snapshot.personaId,
              projectPath: snapshot.projectPath,
              largeModelSelection: snapshot.largeModelSelection,
              reasoningEffort: snapshot.reasoningEffort,
              agentName: requestedAgentName,
            });
            newSessionId = created.id;
            pendingDraftRef.current = {
              sessionId: newSessionId,
              projectPath: snapshot.projectPath,
              largeModelSelection: snapshot.largeModelSelection,
              agentName: requestedAgentName,
            };
          } catch (error) {
            setDraftStreamError(
              error instanceof ChatApiError && error.message
                ? error.message
                : t("stream.errors.createChatFallback"),
            );
            throw error;
          }
        }

        const formData = new FormData();
        formData.set("text", snapshot.text);
        if (snapshot.skillName) formData.set("skillName", snapshot.skillName);
        if (snapshot.personaId) formData.set("personaId", snapshot.personaId);
        if (snapshot.largeModelSelection) {
          formData.set("largeModelSelection", snapshot.largeModelSelection);
        }
        formData.set("reasoningEffort", snapshot.reasoningEffort);
        for (const upload of snapshot.uploads) {
          formData.append("files", upload.file);
        }
        const ws = snapshotWorkspaceForSend(workspaceContextRegistry);
        if (ws) formData.set("workspace", JSON.stringify(ws));

        const result = await postSessionTurn(newSessionId, formData, {
          onUploadProgress: snapshot.uploads.length ? controls.onUploadProgress : undefined,
        });
        if (!result.ok) {
          const message =
            result.message ||
            (result.status === 0
              ? t("stream.errors.sendInvalidResponse")
              : t("stream.errors.sendStatus", { status: result.status }));
          setDraftStreamError({
            message,
            ...(result.code ? { code: result.code } : {}),
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          });
          throw new Error(result.message || `post turn failed (${result.status})`);
        }

        pendingDraftRef.current = null;
        notifySessionsChanged();
        onSessionCreated(newSessionId);
      } finally {
        draftSendInFlightRef.current = false;
      }
    },
    [workspaceContextRegistry, notifySessionsChanged, onSessionCreated, t],
  );

  const handleDraftDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    draftDragDepthRef.current += 1;
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingDraftFiles(true);
  }, []);

  const handleDraftDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDraftDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    draftDragDepthRef.current = Math.max(0, draftDragDepthRef.current - 1);
    if (draftDragDepthRef.current === 0) {
      setIsDraggingDraftFiles(false);
    }
  }, []);

  const handleDraftDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    draftDragDepthRef.current = 0;
    setIsDraggingDraftFiles(false);

    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    draftComposerRef.current?.addFiles(files);
    draftComposerRef.current?.focus();
  }, []);

  if (sessionId) {
    return (
      <Chat
        key={sessionId}
        sessionId={sessionId}
        mainAgentDisplayName={mainAgentDisplayName}
        onSessionsChanged={notifySessionsChanged}
        onSessionNotFound={onSessionNotFound ? () => onSessionNotFound() : undefined}
        onSessionMessage={onSessionMessage}
      />
    );
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={handleDraftDragEnter}
      onDragOver={handleDraftDragOver}
      onDragLeave={handleDraftDragLeave}
      onDrop={handleDraftDrop}
    >
      {isDraggingDraftFiles && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-16 border-2 border-dashed border-info bg-info-bg/85 text-ui text-info-fg md:inset-6">
          {t("composer.dropFiles")}
        </div>
      )}
      <ChatEmptyState
        guardianName={guardianName}
        pinnedChats={pinnedChats}
        onOpenPinnedChat={(id) => navigate(`/chat/${id}`)}
        onUnpinChat={(id) => void handleUnpinChat(id)}
        quickEntries={quickEntries}
        onActivateQuickEntry={handleActivateQuickEntry}
        composer={
          <ChatComposer
            ref={draftComposerRef}
            // Box look lives on the composer so the chip row sits outside it.
            boxClassName="rounded-16 border border-border bg-surface/95 p-4 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
            onSend={handleDraftSend}
            showProjectSelector
            showModelSelector
            initialProjectName={initialProjectName}
            initialAgentMention={initialAgentMention}
            streamError={draftStreamError}
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
    </div>
  );
}
