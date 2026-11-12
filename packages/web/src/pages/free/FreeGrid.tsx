import type { DraftDeviceFolder } from "@/lib/device-folder";
import {
  Chrome,
  FolderKanban,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  PanelRightOpen,
  PanelRightClose,
  Share2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { AgentMention } from "@/lib/chat-types";
import { artifactOwnerId } from "@/lib/artifact-name";
import { prettyAgentName } from "@/lib/agent-name";
import { resolveAppToOpen } from "@/lib/chat-helpers";
import { deleteSession } from "@/lib/chat-api";
import { chatPath, MAIN_CHAT_PATH } from "@/lib/chat-session";
import { useApps } from "@/hooks/use-apps";
import { appDisplayName } from "@/lib/app-display-name";
import { SessionAvatar } from "@/components/chat/SessionAvatar";
import { SessionLoadingTitle } from "@/components/chat/SessionLoadingTitle";
import { useSessionIdentity } from "@/components/chat/use-session-identity";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SlotContent } from "@/components/slot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { emitSessionsChanged } from "@/lib/session-events";
import { AppWidget } from "./AppWidget";
import { ChatWidget } from "./ChatWidget";
import { DesktopWidget } from "./DesktopWidget";
import { ProjectsWidget } from "./ProjectsWidget";
import { PinnedChatWidget } from "./PinnedChatWidget";
import { useConciergeChatId, useConciergeChats, useConciergeName } from "@/hooks/use-concierge";
import { COMPACT_WIDTH, ToolWorkspace } from "./ToolWorkspace";
import { useToolTrace } from "./tool-trace";
import { getWidgetFullHref } from "./widget-links";
import { useSessionNames } from "./use-session-names";
import {
  autoPlaceApp,
  autoPlaceProjects,
  applyFirstPageLayout,
  collapseToolsOnMount,
  isLayoutLoaded,
  placeWidgetsIfSessionActive,
  setActiveSession,
  type PlacementLink,
  updatePlacementLink,
  updatePlacementLinks,
  type WidgetPlacement,
  type WidgetSeed,
  useFreeCells,
} from "./use-free-cells";
import {
  createWorkspaceContextRegistry,
  WorkspaceContextRegistryContext,
} from "./workspace-context";
import { createWorkspaceEventBus, WorkspaceEventBusContext } from "./workspace-event-bus";
import { createWorkspaceStore, WorkspaceStoreContext } from "./workspace-store";

// App widgets render their real installed-app identity (icon + display name),
// matching the sidebar pins and the composer context chips; the lucide grid is
// only the fallback while the catalog loads or the icon is missing.
function useWidgetApp(widget: WidgetPlacement) {
  const { apps } = useApps();
  return widget.type === "app" && widget.targetId
    ? (apps ?? []).find((a) => a.id === widget.targetId)
    : undefined;
}

function WidgetIcon({ widget, className }: { widget: WidgetPlacement; className?: string }) {
  const app = useWidgetApp(widget);
  switch (widget.type) {
    case "chat":
      return <MessageSquare className={className ?? "h-3.5 w-3.5"} />;
    case "desktop":
      return <Chrome className={className ?? "h-3.5 w-3.5"} />;
    case "projects":
      return <FolderKanban className={className ?? "h-3.5 w-3.5"} />;
    case "app":
      return app?.iconUrl ? (
        <img src={app.iconUrl} alt="" className={`${className ?? "h-3.5 w-3.5"} rounded-4`} />
      ) : (
        <LayoutGrid className={className ?? "h-3.5 w-3.5"} />
      );
  }
}

function WidgetContent({
  widget,
  dragging,
  sessionId,
  interaction,
}: {
  widget: WidgetPlacement;
  dragging: boolean;
  sessionId?: string;
  interaction?: boolean;
}) {
  switch (widget.type) {
    case "desktop":
      return <DesktopWidget dragging={dragging} />;
    case "projects":
      return (
        <ProjectsWidget
          dragging={dragging}
          placementId={widget.id}
          initialSelectedPath={widget.selectedPath}
        />
      );
    case "app":
      return widget.targetId ? (
        <AppWidget
          appId={widget.targetId}
          placementId={widget.id}
          sessionId={sessionId}
          interaction={interaction}
          route={widget.route}
          params={widget.params}
          dragging={dragging}
        />
      ) : null;
    case "chat":
      return widget.targetId ? (
        <PinnedChatWidget sessionId={widget.targetId} placementId={widget.id} />
      ) : null;
    default:
      return null;
  }
}

// The mobile header's pane toggle. It follows the pane's effective open state,
// which includes a pane a trace holds open, and collapses or expands for real.
function ToolsToggle({ unread }: { unread: boolean }) {
  const { t } = useTranslation("common");
  const { paneOpen, setPaneCollapsed } = useToolTrace();
  return (
    <IconButton
      size="md"
      label={t(paneOpen ? "chat.collapseTools" : "chat.expandTools")}
      aria-expanded={paneOpen}
      icon={
        <span className="relative">
          {paneOpen ? <PanelRightClose /> : <PanelRightOpen />}
          {!paneOpen && unread && (
            <span
              className="absolute -right-1 -top-1 size-1.5 rounded-full bg-info"
              aria-label={t("chat.toolUpdated")}
            />
          )}
        </span>
      }
      onClick={() => setPaneCollapsed(paneOpen)}
    />
  );
}

/** The phone header's "⋯" menu. */
function MobileChatMenu({
  chatSessionId,
  deletable,
  onShare,
  onDelete,
}: {
  chatSessionId: string | undefined;
  deletable: boolean;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="md"
          label={t("nav.more")}
          icon={<MoreHorizontal />}
          className="text-muted-foreground hover:text-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {chatSessionId && (
          <DropdownMenuItem onSelect={onShare}>
            <Share2 className="size-4" />
            {t("share.title", { ns: "chat", defaultValue: "Share chat" })}
          </DropdownMenuItem>
        )}
        {deletable ? (
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-4" />
            {t("recentChats.delete")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The chat workspace. The chat is the one the route names, `/chat/<id>`, or
 * `sessionId` when the route has no id to name it, as `/message` has not.
 */
export function FreeGrid({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation("common");
  const params = useParams<{ "*"?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    placements,
    addWidget,
    removeWidget,
    toolView,
    toolActivations,
    selectTool,
    setToolsCollapsed,
  } = useFreeCells();
  const { apps } = useApps();
  const sessionNames = useSessionNames(
    placements.flatMap((widget) =>
      widget.type === "chat" && widget.targetId ? [widget.targetId] : [],
    ),
  );
  const widgetLabel = (widget: WidgetPlacement) => {
    if (widget.type === "chat" && widget.targetId) {
      return sessionNames.get(widget.targetId) ?? t("nav.chat");
    }
    if (widget.type === "app") return appDisplayName(widget.targetId, apps, t("nav.apps"));
    return t(
      widget.type === "chat"
        ? "nav.chat"
        : widget.type === "desktop"
          ? "nav.desktop"
          : "nav.projects",
    );
  };
  // Latest placements for the teardown flush handlers, which register once.
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  const [workspaceStore] = useState(() => createWorkspaceStore());
  const [eventBus] = useState(() => createWorkspaceEventBus());
  const [workspaceContextRegistry] = useState(() => createWorkspaceContextRegistry());
  const urlSessionId = sessionId ?? (params["*"]?.split("/")[0] || undefined);
  const locState = location.state as {
    projectPath?: string;
    deviceFolder?: DraftDeviceFolder;
    agentMention?: AgentMention;
    agentName?: string;
    draft?: string;
    skill?: string;
    widgets?: WidgetSeed[];
  } | null;
  // A new tab opened by the sidebar's project plus has no router state, so the
  // project arrives as `?project=` instead. State wins when both exist.
  const queryProjectName = new URLSearchParams(location.search).get("project");
  const initialProjectName = locState?.projectPath?.trim() || queryProjectName?.trim() || undefined;
  const initialDeviceFolder = locState?.deviceFolder;
  const initialAgentMention = useMemo<AgentMention | null>(() => {
    if (locState?.agentMention) return locState.agentMention;
    const agentName = locState?.agentName?.trim();
    if (!agentName) return null;
    const appId = artifactOwnerId(agentName) ?? agentName;
    return {
      appId,
      appLabel: prettyAgentName(appId),
      agentName,
    };
  }, [locState?.agentMention, locState?.agentName]);
  // Composer prefill from `navigateRome({ path: "chat/new", draft, skill })` —
  // task text plus an optional structured skill chip seeded by the Skills app.
  const initialDraftText = locState?.draft || undefined;
  const initialSkillName = locState?.skill || undefined;
  const initialWidgets = locState?.widgets;
  const initialWidgetsKey = useMemo(() => {
    if (!Array.isArray(initialWidgets) || initialWidgets.length === 0) return null;
    return JSON.stringify(initialWidgets);
  }, [initialWidgets]);
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(urlSessionId);
  const flushAppLink = useCallback(
    (p: WidgetPlacement) => {
      if (p.type !== "app") return;
      const link = workspaceContextRegistry.resolveLink(p.id);
      if (link) updatePlacementLink(p.id, link.route, link.params);
    },
    [workspaceContextRegistry],
  );
  const flushLayout = useCallback(() => {
    const links: PlacementLink[] = [];
    for (const p of placementsRef.current) {
      if (p.type !== "app") continue;
      const link = workspaceContextRegistry.resolveLink(p.id);
      if (link) links.push({ placementId: p.id, route: link.route, params: link.params });
    }
    updatePlacementLinks(links);
  }, [workspaceContextRegistry]);

  useEffect(() => {
    collapseToolsOnMount();
  }, []);

  const suppressProjectsRef = useRef(false);
  // A widget handoff waiting for the session's server layout, so it lands on top
  // of that layout instead of making it lose the revision guard.
  const pendingWidgetsRef = useRef<{ sessionId: string; apply: () => void } | null>(null);
  // A layout effect, so the session's cached layout is in the store before the
  // first paint. `flushLayout` still reads the outgoing session's iframes: the
  // render that carries the new URL keeps showing them until the switch below.
  useLayoutEffect(() => {
    flushLayout();
    suppressProjectsRef.current = false;
    setChatSessionId(urlSessionId);
    setActiveSession(urlSessionId ?? null);
    pendingWidgetsRef.current = null;
    const applyInitialWidgets = (targetSessionId: string | null) => {
      if (!initialWidgetsKey || !initialWidgets) {
        return;
      }
      // A narrow workspace shows one pane at a time, so an expanded panel
      // would hide the chat this navigation opened.
      placeWidgetsIfSessionActive(targetSessionId, initialWidgets, {
        chatFirst: window.innerWidth < COMPACT_WIDTH,
      });
    };
    if (!urlSessionId) {
      applyInitialWidgets(null);
    } else if (isLayoutLoaded(urlSessionId)) {
      applyInitialWidgets(urlSessionId);
    } else if (initialWidgetsKey) {
      // The layout rides the session's first messages page; `handleSessionLayout`
      // places the widgets once it has been applied.
      pendingWidgetsRef.current = {
        sessionId: urlSessionId,
        apply: () => applyInitialWidgets(urlSessionId),
      };
    }
  }, [urlSessionId, initialWidgets, initialWidgetsKey, flushLayout]);

  const handleSessionLayout = useCallback((sessionId: string, layout: unknown[] | null) => {
    applyFirstPageLayout(sessionId, layout);
    const pending = pendingWidgetsRef.current;
    if (pending?.sessionId !== sessionId) return;
    pendingWidgetsRef.current = null;
    pending.apply();
  }, []);

  useEffect(() => {
    return eventBus.on<{ appId: string }>("app:installed", ({ appId }) => {
      autoPlaceApp(resolveAppToOpen(appId));
    });
  }, [eventBus]);

  useEffect(() => {
    return eventBus.on<{ paths: string[]; force?: boolean }>("projects:opened", (payload) => {
      if (payload.paths.length === 0) return;
      // A forced open (an explicit click on a /projects link in chat) overrides
      // the user's earlier manual close of the panel; the passive agent-link
      // path (no force) still respects that close.
      if (payload.force) suppressProjectsRef.current = false;
      else if (suppressProjectsRef.current) return;
      autoPlaceProjects(payload.force === true);
    });
  }, [eventBus]);

  // Persist each app tile's live in-app location back onto its placement so the
  // addressed screen survives a reload. AppWidget freezes its `src` at mount, so
  // the user's in-app navigation is invisible to the layout until we read it
  // here from `contentWindow.location` at the moments that precede teardown:
  // `visibilitychange→hidden` (tab switch / mobile background / close) and
  // `pagehide` (desktop reload). Same-origin reads only; cross-origin tiles
  // resolve to null and keep their stored link.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushLayout();
    };
    window.addEventListener("pagehide", flushLayout);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushLayout);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushLayout]);

  useEffect(() => {
    return workspaceStore.subscribe<string | null>("activeTurnId", (value) => {
      if (value) {
        suppressProjectsRef.current = false;
      }
    });
  }, [workspaceStore]);

  const handleRemoveWidget = useCallback(
    (id: string) => {
      const widget = placements.find((p) => p.id === id);
      if (widget?.type === "projects") {
        suppressProjectsRef.current = true;
      }
      removeWidget(id);
    },
    [placements, removeWidget],
  );

  const conciergeChatId = useConciergeChatId();
  const handleSessionChosen = useCallback(
    (chosenId: string) => {
      setChatSessionId(chosenId);
      setActiveSession(chosenId);
      navigate(chatPath(chosenId, conciergeChatId), { replace: true });
    },
    [conciergeChatId, navigate],
  );

  // Session identity for the mobile header bar (the desktop chat navbar resolves
  // its own copy inside Chat). Both read the same hook; see its note on the
  // intentional double-fetch.
  const {
    loading: sessionLoading,
    sessionName,
    model,
    reasoningEffort,
    pinnedAgentMention,
  } = useSessionIdentity(chatSessionId);
  const conciergeChats = useConciergeChats();
  const conciergeName = useConciergeName();
  const isConcierge =
    chatSessionId !== undefined &&
    (chatSessionId === conciergeChatId || conciergeChats.some((chat) => chat.id === chatSessionId));
  // The main chat goes by the guardian's name for the agent, not the session name the server stores.
  const isMainConcierge =
    chatSessionId !== undefined &&
    (chatSessionId === conciergeChatId ||
      conciergeChats.some((chat) => chat.id === chatSessionId && chat.main));
  const chatName = isMainConcierge ? conciergeName : sessionName;
  // The chat a guardian names is the one they keep a tab on, so the name
  // outranks the route's own title. Claimed here rather than in FreePage so it
  // reads the same identity the header does, and follows a rename with it.
  useDocumentTitle(chatName);

  // Delete the active chat from the mobile header's "⋯" menu, mirroring the
  // desktop navbar: drop the session, refresh the sidebar list, land on the
  // main chat.
  const handleDeleteSession = useCallback(async () => {
    if (!chatSessionId) return;
    try {
      await deleteSession(chatSessionId);
    } catch {
      // best-effort — the list refresh below reconciles either way
    }
    emitSessionsChanged();
    navigate(MAIN_CHAT_PATH);
  }, [chatSessionId, navigate]);

  return (
    <WorkspaceEventBusContext.Provider value={eventBus}>
      <WorkspaceStoreContext.Provider value={workspaceStore}>
        <WorkspaceContextRegistryContext.Provider value={workspaceContextRegistry}>
          <ToolWorkspace
            placements={placements}
            view={toolView}
            selectTool={selectTool}
            setCollapsed={setToolsCollapsed}
            addWidget={addWidget}
            removeWidget={handleRemoveWidget}
            label={widgetLabel}
            icon={(widget) => <WidgetIcon widget={widget} />}
            content={(widget, dragging) => (
              <WidgetContent widget={widget} dragging={dragging} sessionId={chatSessionId} />
            )}
            fullHref={getWidgetFullHref}
            // App tiles navigate inside a frozen iframe, so persist the live
            // route before the link is followed; the href then carries it.
            onOpenIntent={flushAppLink}
            activations={toolActivations}
          >
            <ChatWidget
              sessionId={chatSessionId}
              onSessionChosen={handleSessionChosen}
              onSessionLayout={handleSessionLayout}
              initialProjectName={initialProjectName}
              initialDeviceFolder={initialDeviceFolder}
              initialAgentMention={initialAgentMention}
              initialDraftText={initialDraftText}
              initialSkillName={initialSkillName}
            />
            {/* A portal: it renders in the mobile header, and sits here so it
                reads the pane's open state. */}
            <SlotContent name="mobileHeader">
              {isConcierge ? (
                // The chat floats its own header once it shows, and the
                // shell's bar steps aside for it; until then the bar stays
                // empty rather than naming the chat twice.
                <div className="min-w-0 flex-1" />
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <SessionAvatar
                    iconUrl={pinnedAgentMention?.iconUrl}
                    label={pinnedAgentMention?.appLabel}
                    model={model}
                    reasoningEffort={reasoningEffort}
                  />
                  {sessionLoading ? (
                    <SessionLoadingTitle />
                  ) : (
                    <span className="truncate text-ui text-foreground">
                      {chatName?.trim() || pinnedAgentMention?.appLabel || t("recentChats.newChat")}
                    </span>
                  )}
                  {/* Same label as the desktop navbar. */}
                  {sessionName?.trim() && pinnedAgentMention && (
                    <span className="shrink-0 truncate text-aux text-muted-foreground">
                      {pinnedAgentMention.appLabel}
                    </span>
                  )}
                </div>
              )}
              <MobileChatMenu
                chatSessionId={chatSessionId}
                // The main chat is never deleted.
                deletable={!isMainConcierge}
                onShare={() => eventBus.emit("share:start", {})}
                onDelete={() => void handleDeleteSession()}
              />
              <ToolsToggle unread={toolView.unreadIds.length > 0} />
            </SlotContent>
          </ToolWorkspace>
        </WorkspaceContextRegistryContext.Provider>
      </WorkspaceStoreContext.Provider>
    </WorkspaceEventBusContext.Provider>
  );
}
