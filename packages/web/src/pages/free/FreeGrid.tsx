import {
  Chrome,
  FolderKanban,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  PanelRightOpen,
  Share2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { AgentMention } from "@/lib/chat-types";
import { artifactOwnerId } from "@/lib/artifact-name";
import { prettyAgentName } from "@/lib/agent-name";
import { resolveAppToOpen } from "@/lib/chat-helpers";
import { deleteSession } from "@/lib/chat-api";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { useApps } from "@/hooks/use-apps";
import { SessionModelLabel } from "@/components/chat/SessionModelLabel";
import { useSessionIdentity } from "@/components/chat/use-session-identity";
import { SlotContent } from "@/components/slot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { emitSessionsChanged, usePinSession } from "@/lib/session-events";
import { AppWidget } from "./AppWidget";
import { ChatWidget } from "./ChatWidget";
import { DesktopWidget } from "./DesktopWidget";
import { ProjectsWidget } from "./ProjectsWidget";
import { PinnedChatWidget } from "./PinnedChatWidget";
import { ToolWorkspace } from "./ToolWorkspace";
import {
  autoPlaceApp,
  autoPlaceProjects,
  loadLayoutForSession,
  placeWidgetsIfSessionActive,
  setActiveSession,
  updatePlacementLink,
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

export function FreeGrid() {
  const { t } = useTranslation("common");
  const params = useParams<{ "*"?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { placements, addWidget, removeWidget, toolView, selectTool, setToolsCollapsed } =
    useFreeCells();
  const { apps } = useApps();
  const widgetLabel = (widget: WidgetPlacement) => {
    if (widget.type === "app")
      return (
        apps?.find((app) => app.id === widget.targetId)?.displayName ??
        widget.targetId ??
        t("nav.apps")
      );
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
  const urlSessionId = params["*"]?.split("/")[0] || undefined;
  const locState = location.state as {
    projectPath?: string;
    agentMention?: AgentMention;
    agentName?: string;
    draft?: string;
    skill?: string;
    widgets?: WidgetSeed[];
  } | null;
  const initialProjectName = locState?.projectPath?.trim() || undefined;
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
  const flushLayout = useCallback(() => {
    for (const p of placementsRef.current) {
      if (p.type !== "app") continue;
      const link = workspaceContextRegistry.resolveLink(p.id);
      if (link) updatePlacementLink(p.id, link.route, link.params);
    }
  }, [workspaceContextRegistry]);

  const suppressProjectsRef = useRef(false);
  useEffect(() => {
    flushLayout();
    suppressProjectsRef.current = false;
    setChatSessionId(urlSessionId);
    setActiveSession(urlSessionId ?? null);
    const applyInitialWidgets = (targetSessionId: string | null) => {
      if (!initialWidgetsKey || !Array.isArray(initialWidgets) || initialWidgets.length === 0) {
        return;
      }
      placeWidgetsIfSessionActive(targetSessionId, initialWidgets);
    };
    if (urlSessionId) {
      const targetSessionId = urlSessionId;
      void loadLayoutForSession(targetSessionId).finally(() =>
        applyInitialWidgets(targetSessionId),
      );
    } else {
      applyInitialWidgets(null);
    }
  }, [urlSessionId, initialWidgets, initialWidgetsKey, flushLayout]);

  useEffect(() => {
    return eventBus.on<{ appId: string }>("app:installed", ({ appId }) => {
      autoPlaceApp(resolveAppToOpen(appId));
    });
  }, [eventBus]);

  useEffect(() => {
    return eventBus.on<{ paths: string[]; force?: boolean }>("projects:opened", (payload) => {
      if (!payload?.paths || payload.paths.length === 0) return;
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

  const handleSessionChosen = useCallback(
    (sessionId: string) => {
      setChatSessionId(sessionId);
      setActiveSession(sessionId);
      navigate(`/chat/${sessionId}`, { replace: true });
    },
    [navigate],
  );

  // Session identity for the mobile header bar (the desktop chat navbar resolves
  // its own copy inside Chat). Both read the same hook; see its note on the
  // intentional double-fetch.
  const { sessionName, model, pinnedAgentMention, pinnedAt } = useSessionIdentity(chatSessionId);
  const setPinned = usePinSession();

  // Delete the active chat from the mobile header's "⋯" menu, mirroring the
  // desktop navbar: drop the session, refresh the sidebar list, land on a fresh
  // chat.
  const handleDeleteSession = useCallback(async () => {
    if (!chatSessionId) return;
    try {
      await deleteSession(chatSessionId);
    } catch {
      // best-effort — the list refresh below reconciles either way
    }
    emitSessionsChanged();
    navigate("/chat");
  }, [chatSessionId, navigate]);

  const handlePinSession = useCallback(async () => {
    if (!chatSessionId) return;
    try {
      await setPinned(chatSessionId, !pinnedAt);
    } catch {
      // Server truth is unchanged; the next successful session read reconciles.
    }
  }, [chatSessionId, pinnedAt, setPinned]);

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
          >
            {!chatSessionId && (
              <div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-2 max-md:hidden">
                <IconButton
                  size="sm"
                  data-coach={toolView.collapsed ? "add-widget" : undefined}
                  aria-expanded={!toolView.collapsed}
                  onClick={() => setToolsCollapsed(false)}
                  label={t("chat.expandTools")}
                  icon={<PanelRightOpen />}
                />
              </div>
            )}
            <ChatWidget
              sessionId={chatSessionId}
              onSessionChosen={handleSessionChosen}
              initialProjectName={initialProjectName}
              initialAgentMention={initialAgentMention}
              initialDraftText={initialDraftText}
              initialSkillName={initialSkillName}
            />
          </ToolWorkspace>

          <SlotContent name="mobileHeader">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <AgentAvatar
                iconUrl={pinnedAgentMention?.iconUrl}
                label={pinnedAgentMention?.appLabel}
                size="sm"
                className="shrink-0"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-foreground">
                  {sessionName?.trim() || pinnedAgentMention?.appLabel || t("recentChats.newChat")}
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <SessionModelLabel model={model} />
                  {sessionName?.trim() && pinnedAgentMention && (
                    <span className="truncate text-aux text-muted-foreground">
                      {pinnedAgentMention.appLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>
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
                  <DropdownMenuItem onSelect={() => void handlePinSession()}>
                    {pinnedAt ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    {pinnedAt ? t("navbar.unpin", { ns: "chat" }) : t("navbar.pin", { ns: "chat" })}
                  </DropdownMenuItem>
                )}
                {chatSessionId && (
                  <DropdownMenuItem onSelect={() => eventBus.emit("share:start", {})}>
                    <Share2 className="size-4" />
                    {t("share.title", { ns: "chat", defaultValue: "Share chat" })}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={() => void handleDeleteSession()}>
                  <Trash2 className="size-4" />
                  {t("recentChats.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton
              size="md"
              label={t("chat.expandTools")}
              aria-expanded={!toolView.collapsed}
              icon={
                <span className="relative">
                  <PanelRightOpen />
                  {toolView.unreadIds.length > 0 && (
                    <span
                      className="absolute -right-1 -top-1 size-1.5 rounded-full bg-info"
                      aria-label={t("chat.toolUpdated")}
                    />
                  )}
                </span>
              }
              onClick={() => setToolsCollapsed(false)}
            />
          </SlotContent>
        </WorkspaceContextRegistryContext.Provider>
      </WorkspaceStoreContext.Provider>
    </WorkspaceEventBusContext.Provider>
  );
}
