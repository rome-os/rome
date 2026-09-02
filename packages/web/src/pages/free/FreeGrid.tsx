import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Chrome,
  ExternalLink,
  FolderKanban,
  GripVertical,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { AgentMention } from "@/lib/chat-types";
import { artifactOwnerId } from "@/lib/artifact-name";
import { prettyAgentName } from "@/lib/agent-name";
import { resolveAppToOpen } from "@/lib/chat-helpers";
import { deleteSession } from "@/lib/chat-api";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { useApps } from "@/hooks/use-apps";
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
import { buildFullAppPath, getWidgetFullHref } from "./widget-links";
import { WidgetPicker } from "./WidgetPicker";
import {
  autoPlaceApp,
  autoPlaceProjects,
  loadLayoutForSession,
  placeWidgetsIfSessionActive,
  setActiveSession,
  STRIP_ITEM_MIN_WIDTH,
  updatePlacementLink,
  type WidgetPlacement,
  type WidgetSeed,
  type WidgetType,
  useFreeCells,
} from "./use-free-cells";
import {
  createWorkspaceContextRegistry,
  useWorkspaceContextRegistry,
  WorkspaceContextRegistryContext,
} from "./workspace-context";
import { createWorkspaceEventBus, WorkspaceEventBusContext } from "./workspace-event-bus";
import { createWorkspaceStore, WorkspaceStoreContext } from "./workspace-store";

// Width of the chat column when a widget is open (desktop). Fluid so a wide
// screen gives the conversation more room without starving the app strip, and
// clamped at both ends. Single source of truth, consumed in two coupled spots:
// the chat column's own width, and the app overlay's left offset (which must
// stay flush against it) — each reads it through a self-scoped CSS var.
const CHAT_COLUMN_WIDTH = "clamp(420px, 34vw, 680px)";

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

function WidgetLabel({ widget }: { widget: WidgetPlacement }) {
  const { t } = useTranslation("common");
  const app = useWidgetApp(widget);
  switch (widget.type) {
    case "chat":
      return <span>{t("nav.chat")}</span>;
    case "desktop":
      return <span>{t("nav.desktop")}</span>;
    case "projects":
      return <span>{t("nav.projects")}</span>;
    case "app":
      return <span>{app?.displayName ?? widget.targetId ?? t("nav.apps")}</span>;
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
    default:
      return null;
  }
}

function SortableWidgetCard({
  widget,
  activeId,
  dragging,
  onRemove,
  minWidth,
  mobileHidden,
  sessionId,
  interaction,
}: {
  widget: WidgetPlacement;
  activeId: string | null;
  dragging: boolean;
  onRemove: () => void;
  minWidth: number;
  mobileHidden: boolean;
  sessionId?: string;
  interaction?: boolean;
}) {
  const { t } = useTranslation("common");
  const prefersReducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: widget.id });

  const isActive = widget.id === activeId;

  // The full-screen href for this widget. App tiles freeze their iframe src at
  // mount and navigate internally, so the placement's stored route can trail
  // the live screen; re-read the iframe's URL at the moments that precede
  // opening (hover, press, focus) so the link carries where the user actually
  // is. Builtins derive fully from the placement.
  const registry = useWorkspaceContextRegistry();
  const [liveAppHref, setLiveAppHref] = useState<string | null>(null);
  const fullHref = liveAppHref ?? getWidgetFullHref(widget);
  const refreshFullHref = useCallback(() => {
    if (widget.type !== "app" || !widget.targetId) return;
    const link = registry?.resolveLink(widget.id);
    if (link) setLiveAppHref(buildFullAppPath(widget.targetId, link.route, link.params));
  }, [registry, widget]);

  return (
    <div
      ref={setNodeRef}
      className={`relative flex h-full min-w-0 flex-1 flex-shrink-0 flex-col overflow-hidden rounded-12 border bg-surface pb-safe md:pb-0 ${
        isActive ? "z-40 border-ring shadow-25" : "z-10 border-border"
      } ${mobileHidden ? "max-md:hidden" : ""}`}
      style={{
        minWidth: minWidth,
        transform: CSS.Transform.toString(transform),
        transition: prefersReducedMotion ? "none" : (transition ?? undefined),
      }}
    >
      {/* Card header — drag handle + close. Hidden on mobile because the
          top tab pill already owns title + close affordance there. */}
      <div
        ref={setActivatorNodeRef}
        className="flex cursor-grab items-center gap-2 border-b border-border-subtle px-2 py-1 select-none active:cursor-grabbing max-md:hidden"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" />
        <WidgetIcon widget={widget} />
        <span className="flex-1 truncate text-aux text-subtle-foreground">
          <WidgetLabel widget={widget} />
        </span>
        {/* The design surface is system-managed while the handoff holds the
            floor: leaving is the chat's "Main" back bar (non-destructive) and
            cancelling is the surface's own Cancel button — so it carries no
            generic open/close affordances that could be mistaken for either. */}
        {!interaction && (
          <>
            {fullHref && (
              <a
                href={fullHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("chat.openWidgetNewTab")}
                title={t("chat.openWidgetNewTab")}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerEnter={refreshFullHref}
                onFocus={refreshFullHref}
                className="rounded-4 p-1 text-subtle-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <button
              type="button"
              aria-label={t("sidebar.remove")}
              title={t("sidebar.remove")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onRemove}
              className="rounded-4 p-1 text-subtle-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto overscroll-y-contain">
        <WidgetContent
          widget={widget}
          dragging={dragging}
          sessionId={sessionId}
          interaction={interaction}
        />
      </div>
    </div>
  );
}

export function FreeGrid() {
  const { t } = useTranslation("common");
  const params = useParams<{ "*"?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { placements, addWidget, removeWidget, moveWidget } = useFreeCells();
  // Latest placements for the teardown flush handlers, which register once.
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  const [activeId, setActiveId] = useState<string | null>(null);
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
  const stripRef = useRef<HTMLDivElement>(null);
  const [itemMinWidth, setItemMinWidth] = useState(STRIP_ITEM_MIN_WIDTH);
  // "chat" or a widget placement id.
  const [mobileTab, setMobileTab] = useState<"chat" | string>("chat");
  const prefersReducedMotion = useReducedMotion();

  const suppressProjectsRef = useRef(false);
  useEffect(() => {
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
  }, [urlSessionId, initialWidgets, initialWidgetsKey]);

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
      autoPlaceProjects();
    });
  }, [eventBus]);

  // Scroll to end of strip when a widget is added; on mobile, jump to the
  // newly added widget's tab.
  const prevCountRef = useRef(placements.length);
  useEffect(() => {
    if (placements.length > prevCountRef.current) {
      const newest = [...placements].sort((a, b) => b.order - a.order)[0];
      // An app widget often opens *alongside* an in-progress draft (an agent
      // `show_app` placed a glanceable surface mid-turn). Stealing the mobile
      // tab would hide the composer, so keep chat focused for apps and let the
      // user reveal them; user-added builtins (projects/desktop) still jump.
      if (newest && newest.type !== "app") setMobileTab(newest.id);
      if (stripRef.current) {
        requestAnimationFrame(() => {
          const el = stripRef.current;
          if (el) el.scrollTo({ left: el.scrollWidth });
        });
      }
    } else if (placements.length === 0) {
      setMobileTab("chat");
    }
    prevCountRef.current = placements.length;
  }, [placements]);

  // If the active mobile tab's widget gets removed, fall back to chat.
  useEffect(() => {
    if (mobileTab !== "chat" && !placements.some((p) => p.id === mobileTab)) {
      setMobileTab("chat");
    }
  }, [placements, mobileTab]);

  const hasApps = placements.length > 0;
  const isDragging = activeId !== null;

  useEffect(() => {
    const el = stripRef.current;
    if (!el || !hasApps) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentBoxSize[0].inlineSize;
      setItemMinWidth(Math.max(STRIP_ITEM_MIN_WIDTH, Math.floor((w - 8) / 2)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasApps]);

  const sorted = useMemo(() => [...placements].sort((a, b) => a.order - b.order), [placements]);
  const sortedIds = useMemo(() => sorted.map((p) => p.id), [sorted]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        moveWidget(String(active.id), String(over.id));
      }
      setActiveId(null);
    },
    [moveWidget],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  // Persist each app tile's live in-app location back onto its placement so the
  // addressed screen survives a reload. AppWidget freezes its `src` at mount, so
  // the user's in-app navigation is invisible to the layout until we read it
  // here from `contentWindow.location` at the moments that precede teardown:
  // `visibilitychange→hidden` (tab switch / mobile background / close) and
  // `pagehide` (desktop reload). Same-origin reads only; cross-origin tiles
  // resolve to null and keep their stored link.
  useEffect(() => {
    const flush = () => {
      for (const p of placementsRef.current) {
        if (p.type !== "app") continue;
        const link = workspaceContextRegistry.resolveLink(p.id);
        if (link) updatePlacementLink(p.id, link.route, link.params);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspaceContextRegistry]);

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
  const { sessionName, pinnedAgentMention, pinnedAt } = useSessionIdentity(chatSessionId);
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
          {/*
          Chat-as-base layout with mobile tab switching:
          - Desktop (md+): chat is a fluid column (CHAT_COLUMN_WIDTH); apps slide
            in from the right as an overlay positioned flush against the chat.
          - Mobile: chat and apps each take the full viewport, and a bottom
            tab pill switches between them. Adding a widget auto-switches
            to the Apps tab.
        */}
          <div
            style={{ "--rome-chat-col": CHAT_COLUMN_WIDTH } as CSSProperties}
            className={`relative flex min-h-0 flex-1 flex-col transition-[width] duration-300 ${
              hasApps ? "md:w-[var(--rome-chat-col)]" : "w-full"
            } ${mobileTab !== "chat" ? "max-md:hidden" : ""}`}
          >
            <ChatWidget
              sessionId={chatSessionId}
              onSessionChosen={handleSessionChosen}
              initialProjectName={initialProjectName}
              initialAgentMention={initialAgentMention}
              initialDraftText={initialDraftText}
              initialSkillName={initialSkillName}
            />
          </div>

          {/* Apps overlay — slides in from the right above the chat.
            On md+ it sits flush against the chat; its left offset is the
            sidebar width the shell publishes as --rome-chat-left (16rem
            expanded, 4rem collapsed, 0 hidden) plus the chat column width. The
            calc lives in the inline style (plain CSS) so Tailwind's
            arbitrary-value operator spacing never mangles the var names. On
            mobile it covers the full screen, toggled via the bottom tab pill. */}
          <AnimatePresence>
            {hasApps && (
              <motion.aside
                key="apps-overlay"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 320, damping: 32 }
                }
                style={
                  {
                    "--rome-apps-left": `calc(var(--rome-chat-left, 16rem) + ${CHAT_COLUMN_WIDTH})`,
                  } as CSSProperties
                }
                className={`fixed inset-0 z-20 bg-background md:h-dvh md:left-[var(--rome-apps-left)] max-md:top-[var(--rome-mobile-header-height)] ${
                  mobileTab === "chat" ? "max-md:hidden" : ""
                }`}
              >
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                >
                  <SortableContext items={sortedIds} strategy={horizontalListSortingStrategy}>
                    <div
                      ref={stripRef}
                      className="flex h-full gap-2 overflow-x-auto overscroll-x-contain p-2 max-md:flex-col max-md:overflow-x-visible max-md:overflow-y-auto"
                    >
                      {sorted.map((widget) => (
                        <SortableWidgetCard
                          key={widget.id}
                          widget={widget}
                          activeId={activeId}
                          dragging={isDragging}
                          onRemove={() => handleRemoveWidget(widget.id)}
                          minWidth={itemMinWidth}
                          mobileHidden={widget.id !== mobileTab}
                          sessionId={chatSessionId}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </motion.aside>
            )}
          </AnimatePresence>

          {/* Mobile header bar — portaled into the shell's top header so the chat
            route shows one cohesive bar (like the desktop chat navbar) instead
            of the generic Rome wordmark. The leading center region is the
            session identity when there are no apps, and a horizontally-scrolling
            [Chat] [App1] [App2] … tab strip once apps are open. The trailing
            "+" / "⋯" mirror the desktop navbar actions. */}
          <SlotContent name="mobileHeader">
            {hasApps ? (
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setMobileTab("chat")}
                  className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-aux transition ${
                    mobileTab === "chat"
                      ? "bg-surface-hover text-foreground"
                      : "text-subtle-foreground hover:text-foreground"
                  }`}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span>{t("nav.chat")}</span>
                </button>
                {sorted.map((widget) => {
                  const active = mobileTab === widget.id;
                  return (
                    <div
                      key={widget.id}
                      className={`flex shrink-0 items-center rounded-full text-aux transition ${
                        active ? "bg-surface-hover text-foreground" : "text-subtle-foreground"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setMobileTab(widget.id)}
                        className="flex items-center gap-1 rounded-full py-1 pl-3 pr-2"
                      >
                        <WidgetIcon widget={widget} />
                        <WidgetLabel widget={widget} />
                      </button>
                      {active && (
                        <button
                          type="button"
                          onClick={() => handleRemoveWidget(widget.id)}
                          className="-ml-1 mr-1 rounded-full p-1 hover:text-foreground"
                          aria-label={t("sidebar.remove")}
                          title={t("sidebar.remove")}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <AgentAvatar
                  iconUrl={pinnedAgentMention?.iconUrl}
                  label={pinnedAgentMention?.appLabel}
                  size="sm"
                  className="shrink-0"
                />
                <span className="truncate text-ui text-foreground">
                  {sessionName?.trim() || pinnedAgentMention?.appLabel || t("recentChats.newChat")}
                </span>
                {sessionName?.trim() && pinnedAgentMention && (
                  <span className="shrink-0 truncate text-aux text-muted-foreground">
                    {pinnedAgentMention.appLabel}
                  </span>
                )}
              </div>
            )}
            <WidgetPicker
              onSelect={(type: WidgetType, targetId?: string) => addWidget(type, targetId)}
            >
              <IconButton
                size="md"
                label={t("chat.add")}
                icon={<Plus />}
                className="text-muted-foreground hover:text-foreground"
              />
            </WidgetPicker>
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
          </SlotContent>
        </WorkspaceContextRegistryContext.Provider>
      </WorkspaceStoreContext.Provider>
    </WorkspaceEventBusContext.Provider>
  );
}
