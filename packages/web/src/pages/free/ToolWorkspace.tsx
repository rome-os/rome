import {
  ChevronDown,
  ExternalLink,
  LayoutGrid,
  ListTree,
  PanelRightClose,
  Plus,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WidgetPicker } from "./WidgetPicker";
import { SlotContent, useSlotOutlet } from "@/components/slot";
import { TITLEBAR_END_SLOT } from "@/shell/DesktopTitlebar";
import { ToolTraceContext, type ToolTraceHost, type ToolTraceTab } from "./tool-trace";
import type { ToolView, WidgetPlacement, WidgetType } from "./use-free-cells";

const WIDTH_KEY = "rome:tool-chat-ratio";
const DEFAULT_RATIO = 0.4;
const MIN_PANE_WIDTH = 360;
const SEPARATOR_WIDTH = 1;
export const COMPACT_WIDTH = MIN_PANE_WIDTH * 2 + SEPARATOR_WIDTH;
// Tab value of the Trace tab. Widget ids are generated, so it cannot collide.
const TRACE_TAB_ID = "__trace__";

function readRatio() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    if (value >= 0.2 && value <= 0.8) return value;
  } catch {}
  return DEFAULT_RATIO;
}

interface ToolTabProps {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  unread?: boolean;
  /** Shown as a pulsing dot with this accessible name. */
  liveLabel?: string;
  onClose: () => void;
}

function ToolTab({ id, label, icon, active, unread = false, liveLabel, onClose }: ToolTabProps) {
  const { t } = useTranslation("common");
  const tabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (active) tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={tabRef}
      className={`relative flex h-9 shrink-0 items-center gap-1 rounded-12 pr-1 transition-colors ${active ? "bg-surface-muted" : ""}`}
    >
      <TabsTrigger
        value={id}
        role="tab"
        aria-selected={active}
        title={label}
        className="h-full max-w-48 gap-2 after:hidden"
        onKeyDown={(event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {icon}
        <span className="truncate">{label}</span>
        {unread && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-info"
            aria-label={t("chat.toolUpdated")}
          />
        )}
        {liveLabel && (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
            aria-label={liveLabel}
          />
        )}
      </TabsTrigger>
      <IconButton
        size="xs"
        icon={<X />}
        label={t("chat.closeTool", { name: label })}
        onClick={onClose}
        className="text-subtle-foreground"
      />
    </div>
  );
}

interface ToolWorkspaceProps {
  placements: WidgetPlacement[];
  view: ToolView;
  selectTool: (id: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  addWidget: (type: WidgetType, targetId?: string) => void;
  removeWidget: (id: string) => void;
  label: (widget: WidgetPlacement) => string;
  icon: (widget: WidgetPlacement) => ReactNode;
  content: (widget: WidgetPlacement, dragging: boolean) => ReactNode;
  /** Standalone page showing the same surface, or null when there is none. */
  fullHref: (widget: WidgetPlacement) => string | null;
  /** Fires just before the full-page link can be followed, to refresh it. */
  onOpenIntent?: (widget: WidgetPlacement) => void;
  /** The store's count of explicit app activations; a change leaves the Trace tab. */
  activations?: number;
  children: ReactNode;
}

export function ToolWorkspace({
  placements,
  view,
  selectTool,
  setCollapsed,
  addWidget,
  removeWidget,
  label,
  icon,
  content,
  fullHref,
  onOpenIntent,
  activations,
  children,
}: ToolWorkspaceProps) {
  const { t } = useTranslation("common");
  const { t: tActivity } = useTranslation("activity");
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(readRatio);
  const [resizing, setResizing] = useState(false);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);

  // The Trace tab is view state, not layout: it lives here, never reaches
  // `use-free-cells`, and so is not saved with the session. Selecting it leaves
  // the store's `activeId` alone, so the app tab that was active before is
  // still the one the store holds, and closing the Trace tab restores it by
  // clearing `traceSelected`.
  //
  // The pane's expansion is view state too. The store's `collapsed` is saved per
  // session and written through the module-global active session, so a trace
  // must never write it: a write could land on another session after a switch,
  // and a reload would bring back a pane that nothing fills. Instead, a trace
  // opened over a collapsed pane sets `traceHoldsOpen`, and the pane renders
  // open while the tab exists. Ending the trace clears the flag, and the pane
  // falls back to the session's stored state: a collapsed pane is collapsed
  // again, an open pane stays open on its previous app tab.
  // - The pane's collapse button clears the flag and collapses for real. The
  //   tab stays, and expanding shows it again.
  // - Choosing an app tab or adding an app expands the pane for real, through
  //   the store, because the user has moved on to the pane. The flag is then
  //   redundant and clears, so the app stays visible after the trace closes.
  const [trace, setTrace] = useState<{ owner: string; streaming: boolean } | null>(null);
  const [traceSelected, setTraceSelected] = useState(false);
  const [traceHoldsOpen, setTraceHoldsOpen] = useState(false);
  const traceOwnerRef = useRef<string | null>(null);
  const traceCloseRef = useRef<(() => void) | null>(null);
  const latest = useRef({ view, setCollapsed });
  latest.current = { view, setCollapsed };

  const reveal = useCallback(() => {
    if (latest.current.view.collapsed) setTraceHoldsOpen(true);
    setTraceSelected(true);
  }, []);

  const setTraceTab = useCallback(
    (owner: string, tab: ToolTraceTab | null) => {
      if (tab === null) {
        if (traceOwnerRef.current !== owner) return;
        traceOwnerRef.current = null;
        traceCloseRef.current = null;
        setTraceSelected(false);
        setTraceHoldsOpen(false);
        setTrace(null);
        return;
      }
      const previousOwner = traceOwnerRef.current;
      const previousClose = traceCloseRef.current;
      traceOwnerRef.current = owner;
      traceCloseRef.current = tab.onClose;
      if (previousOwner !== owner) previousClose?.();
      setTrace((prev) =>
        prev && prev.owner === owner && prev.streaming === tab.streaming
          ? prev
          : { owner, streaming: tab.streaming },
      );
      if (previousOwner === null) reveal();
    },
    [reveal],
  );

  // Only the user's own choice of an app deselects the Trace tab: a tab or
  // picker here, or an explicit activation elsewhere (a chat link), which the
  // store counts. Store-side changes, such as an agent re-placing the active
  // app under a new id or a background app closing, move `view.activeId`
  // without the user asking to leave the trace, so they never touch it.
  useEffect(() => {
    if (activations !== undefined) setTraceSelected(false);
  }, [activations]);

  function addAndShow(type: WidgetType, targetId?: string) {
    setTraceSelected(false);
    addWidget(type, targetId);
  }

  // A real expansion supersedes the hold.
  useEffect(() => {
    if (!view.collapsed) setTraceHoldsOpen(false);
  }, [view.collapsed]);

  const open = !view.collapsed || (trace !== null && traceHoldsOpen);
  const setPaneCollapsed = useCallback((collapsed: boolean) => {
    setTraceHoldsOpen(false);
    latest.current.setCollapsed(collapsed);
  }, []);

  const traceActive = trace !== null && traceSelected;
  const traceHost = useMemo<ToolTraceHost>(
    () => ({ outlet, paneOpen: open, setPaneCollapsed, reveal, set: setTraceTab }),
    [outlet, open, setPaneCollapsed, reveal, setTraceTab],
  );
  const sorted = [...placements].sort((a, b) => a.order - b.order);
  const hasTabs = sorted.length > 0 || trace !== null;
  const compact = width < COMPACT_WIDTH;
  const activeWidget = traceActive
    ? undefined
    : sorted.find((widget) => widget.id === view.activeId);
  const activeHref = activeWidget ? fullHref(activeWidget) : null;
  const available = Math.max(0, width - SEPARATOR_WIDTH);
  const chatWidth = Math.max(
    MIN_PANE_WIDTH,
    Math.min(available - MIN_PANE_WIDTH, available * ratio),
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // In the Mac app the tabs move up into the title bar, over this panel, so the
  // window has one row on top. The header there is as wide as the panel.
  const inTitlebar = useSlotOutlet(TITLEBAR_END_SLOT);
  const toolsWidth = compact ? width : Math.max(0, width - chatWidth - SEPARATOR_WIDTH);
  // The tabs keep the `Tabs` root's context through the portal, but not its
  // CSS group, so the list states its full height itself.
  const header = (
    <>
      {hasTabs ? (
        <TabsList
          aria-label={t("chat.tools")}
          className="h-full min-w-0 flex-1 justify-start overflow-x-auto p-0"
        >
          {trace && (
            <ToolTab
              id={TRACE_TAB_ID}
              label={tActivity("trace.drawer.title")}
              icon={<ListTree className="size-3.5" />}
              active={traceActive}
              liveLabel={trace.streaming ? tActivity("trace.drawer.live") : undefined}
              onClose={() => traceCloseRef.current?.()}
            />
          )}
          {sorted.map((widget) => (
            <ToolTab
              key={widget.id}
              id={widget.id}
              label={label(widget)}
              icon={icon(widget)}
              active={!traceActive && widget.id === view.activeId}
              unread={view.unreadIds.includes(widget.id)}
              onClose={() => closeTab(widget.id)}
            />
          ))}
        </TabsList>
      ) : (
        <span className="flex h-full flex-1 items-center px-2 text-ui text-muted-foreground">
          {t("chat.tools")}
        </span>
      )}
      {activeWidget && activeHref && (
        // A real link, so middle-click, Cmd-click and copy-link work natively.
        <Button asChild variant="ghost" size="icon-sm">
          <a
            href={activeHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("chat.openToolNewTab", { name: label(activeWidget) })}
            title={t("chat.openToolNewTab", { name: label(activeWidget) })}
            onPointerEnter={() => onOpenIntent?.(activeWidget)}
            onPointerDown={() => onOpenIntent?.(activeWidget)}
            onFocus={() => onOpenIntent?.(activeWidget)}
          >
            <ExternalLink />
          </a>
        </Button>
      )}
      {hasTabs && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={t("chat.allTools")} icon={<ChevronDown />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {trace && (
              <DropdownMenuItem onSelect={() => pickTab(TRACE_TAB_ID)}>
                <ListTree className="size-3.5" />
                {tActivity("trace.drawer.title")}
              </DropdownMenuItem>
            )}
            {sorted.map((widget) => (
              <DropdownMenuItem key={widget.id} onSelect={() => pickTab(widget.id)}>
                {icon(widget)}
                {label(widget)}
                {view.unreadIds.includes(widget.id) && (
                  <span className="ml-auto text-aux text-muted-foreground">
                    {t("chat.toolUpdated")}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasTabs && (
        <WidgetPicker onSelect={addAndShow} placements={placements}>
          <IconButton size="sm" data-coach="add-widget" label={t("chat.add")} icon={<Plus />} />
        </WidgetPicker>
      )}
      <IconButton
        size="sm"
        className="max-md:hidden"
        label={t("chat.collapseTools")}
        aria-expanded={true}
        icon={<PanelRightClose />}
        onClick={() => setPaneCollapsed(true)}
      />
    </>
  );

  function pickTab(id: string) {
    if (id === TRACE_TAB_ID) {
      setTraceSelected(true);
      return;
    }
    setTraceSelected(false);
    selectTool(id);
  }

  function changeRatio(next: number) {
    const constrained = Math.max(0.2, Math.min(0.8, next));
    setRatio(constrained);
    try {
      localStorage.setItem(WIDTH_KEY, String(constrained));
    } catch {}
  }

  function closeTab(id: string) {
    const focused = document.activeElement;
    const restoreFocus =
      focused instanceof Element &&
      rootRef.current?.contains(focused) &&
      (focused.closest('[role="tablist"]') || focused.closest('[role="tabpanel"]'));
    removeWidget(id);
    if (restoreFocus)
      requestAnimationFrame(() => {
        const target =
          rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
          rootRef.current?.querySelector<HTMLElement>('[data-coach="add-widget"]');
        target?.focus();
      });
  }

  return (
    <ToolTraceContext.Provider value={traceHost}>
      <div
        ref={rootRef}
        data-testid="tool-workspace"
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{ "--rome-chat-col": open && !compact ? `${chatWidth}px` : "100%" } as CSSProperties}
      >
        <div
          className="relative flex min-h-0 min-w-0 flex-col"
          data-testid="workspace-chat"
          style={{
            display: compact && open ? "none" : undefined,
            width: open && !compact ? chatWidth : "100%",
            flexShrink: 0,
          }}
        >
          {children}
        </div>
        {open && !compact && (
          <div
            role="separator"
            tabIndex={0}
            aria-label={t("chat.resizeTools")}
            aria-orientation="vertical"
            aria-valuemin={MIN_PANE_WIDTH}
            aria-valuemax={Math.round(available - MIN_PANE_WIDTH)}
            aria-valuenow={Math.round(chatWidth)}
            data-resizing={resizing || undefined}
            className="relative z-40 w-px shrink-0 cursor-col-resize touch-none before:absolute before:inset-y-0 before:-inset-x-1 after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border-subtle after:transition-[width] hover:after:w-1 focus-visible:outline-ring/50 focus-visible:after:w-1 data-[resizing]:after:w-1"
            onDoubleClick={() => changeRatio(DEFAULT_RATIO)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const left = rootRef.current?.getBoundingClientRect().left ?? 0;
              changeRatio(
                Math.max(
                  MIN_PANE_WIDTH,
                  Math.min(available - MIN_PANE_WIDTH, event.clientX - left),
                ) / available,
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              setResizing(false);
            }}
            onLostPointerCapture={() => setResizing(false)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
              event.preventDefault();
              changeRatio(
                event.key === "Home"
                  ? DEFAULT_RATIO
                  : (chatWidth + (event.key === "ArrowLeft" ? -24 : 24)) / available,
              );
            }}
          />
        )}
        <Tabs
          value={traceActive ? TRACE_TAB_ID : (view.activeId ?? "")}
          onValueChange={pickTab}
          activationMode="automatic"
          className="min-h-0 min-w-0 flex-1 gap-0 bg-background"
          style={{ display: open ? undefined : "none" }}
        >
          {inTitlebar ? (
            open ? (
              <SlotContent name={TITLEBAR_END_SLOT}>
                <div
                  className="flex h-full shrink-0 items-center gap-1 px-2"
                  style={{ width: toolsWidth }}
                >
                  {header}
                </div>
              </SlotContent>
            ) : null
          ) : (
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
              {header}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {placements.length === 0 && !traceActive && (
              <EmptyState className="h-full" role="region">
                <EmptyStateIcon>
                  <LayoutGrid />
                </EmptyStateIcon>
                <EmptyStateTitle>{t("chat.emptyAppsTitle")}</EmptyStateTitle>
                <EmptyStateDescription>{t("chat.emptyAppsDescription")}</EmptyStateDescription>
                <EmptyStateAction>
                  <WidgetPicker onSelect={addAndShow} placements={placements}>
                    <Button data-coach="add-widget" variant="outline">
                      <Plus data-icon="inline-start" />
                      {t("chat.add")}
                    </Button>
                  </WidgetPicker>
                </EmptyStateAction>
              </EmptyState>
            )}
            {/* Moving an iframe's DOM node reloads it. Keep content in a stable
                order when loading a saved layout. */}
            {[...placements]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((widget) => (
                <TabsContent
                  key={widget.id}
                  value={widget.id}
                  forceMount
                  inert={traceActive || widget.id !== view.activeId}
                  aria-hidden={traceActive || widget.id !== view.activeId}
                  style={{
                    display: !traceActive && widget.id === view.activeId ? undefined : "none",
                  }}
                  className="absolute inset-0 overflow-auto overscroll-y-contain pb-safe md:pb-0"
                >
                  {content(widget, resizing)}
                </TabsContent>
              ))}
            {/* Kept mounted while the trace exists, and hidden with `visibility`
              rather than `display`, so its scroll position and live following
              survive switching to an app tab. `display: none` would reset the
              scroller. The panel is absolutely positioned, so hiding it takes
              no layout space, and a hidden element takes no pointer events. The
              trace's owner portals its body into the outlet. */}
            {trace && (
              <TabsContent
                value={TRACE_TAB_ID}
                forceMount
                inert={!traceActive}
                aria-hidden={!traceActive}
                style={{ visibility: traceActive ? undefined : "hidden" }}
                className="absolute inset-0 overflow-hidden"
              >
                <div ref={setOutlet} className="flex h-full min-h-0 flex-col" />
              </TabsContent>
            )}
          </div>
        </Tabs>
        {resizing && <div className="absolute inset-0 z-30 cursor-col-resize" />}
      </div>
    </ToolTraceContext.Provider>
  );
}
