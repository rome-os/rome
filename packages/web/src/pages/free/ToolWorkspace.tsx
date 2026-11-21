import {
  ChevronDown,
  ExternalLink,
  FileOutput,
  LayoutGrid,
  ListChecks,
  ListTree,
  PanelRightClose,
  Plus,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { fitTabs } from "./tool-tab-fit";
import { TaskList } from "@/components/concierge/TaskList";
import { type LeaveGuard, leaveEditor } from "@/components/chat/outputs/OutputEditor";
import { OutputsPanel } from "@/components/chat/outputs/OutputsPanel";
import { type OutputsTabOptions, ToolOutputsContext, type ToolOutputsHost } from "./tool-outputs";
import { ToolTasksContext, type ToolTasksHost } from "./tool-tasks";
import { ToolTraceContext, type ToolTraceHost, type ToolTraceTab } from "./tool-trace";
import {
  COMPACT_WIDTH,
  type ToolView,
  type WidgetPlacement,
  type WidgetType,
} from "./use-free-cells";
import { usePaneResize } from "@/hooks/use-pane-resize";
import { readStored, writeStored } from "@/lib/stored-preference";

export { COMPACT_WIDTH } from "./use-free-cells";

const WIDTH_KEY = "rome:tool-chat-ratio";
const DEFAULT_RATIO = 0.4;
const MIN_PANE_WIDTH = 360;
// The widest a tab's name and dot run before the name is cut: the trigger's
// `max-w-48` (192 px) less its left padding and border.
const MAX_TAB_CONTENT_WIDTH = 182;

/** The width of what `el` holds side by side: its children and the gaps between them. */
function contentWidth(el: HTMLElement) {
  const children = [...el.children] as HTMLElement[];
  const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
  return (
    children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
    gap * Math.max(0, children.length - 1)
  );
}
const SEPARATOR_WIDTH = 1;
// Tab value of the Trace tab. Widget ids are generated, so it cannot collide.
const TRACE_TAB_ID = "__trace__";
// Tab value of the Tasks tab, likewise.
const TASKS_TAB_ID = "__tasks__";
// Tab value of the Outputs tab, likewise.
const OUTPUTS_TAB_ID = "__outputs__";
type BuiltinTab = "trace" | "tasks" | "outputs";

function readRatio() {
  const value = Number(readStored(WIDTH_KEY));
  return value >= 0.2 && value <= 0.8 ? value : DEFAULT_RATIO;
}

interface ToolTabProps {
  id: string;
  label: string;
  active: boolean;
  unread?: boolean;
  /** Shown as a pulsing dot with this accessible name. */
  liveLabel?: string;
  onClose: () => void;
}

/**
 * One tab of the strip: its name and, right after it, its close button, with
 * no icon. A tab is as wide as its name, up to `max-w-48` for the name, so
 * several fit before the strip drops some into its menu, which keeps the
 * icons.
 */
function ToolTab({ id, label, active, unread = false, liveLabel, onClose }: ToolTabProps) {
  const { t } = useTranslation("common");

  return (
    <div
      data-tool-tab={id}
      className={`relative flex h-9 min-w-0 shrink items-center rounded-12 pr-1 transition-colors ${active ? "bg-surface-muted" : ""}`}
    >
      <TabsTrigger
        value={id}
        role="tab"
        aria-selected={active}
        title={label}
        className="h-full min-w-0 max-w-48 gap-1 pr-0 pl-2 after:hidden"
        onKeyDown={(event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <span data-tool-tab-label className="truncate">
          {label}
        </span>
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
        // Its glyph sits inside a 24 px box; pulled in, it follows the name closely.
        className="-ml-1 text-subtle-foreground"
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
  const { t: tChat } = useTranslation("chat");
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(readRatio);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState<number | null>(null);

  // The Trace tab is view state, not layout: it lives here, never reaches
  // `use-free-cells`, and so is not saved with the session. Selecting it leaves
  // the store's `activeId` alone, so the app tab that was active before is
  // still the one the store holds, and closing the Trace tab restores it by
  // clearing `selected`.
  //
  // The pane's expansion is view state too. The store's `collapsed` is saved per
  // session and written through the module-global active session, so a trace
  // must never write it: a write could land on another session after a switch,
  // and a reload would bring back a pane that nothing fills. Instead, a trace
  // opened over a collapsed pane sets `holdsOpen`, and the pane renders
  // open while the tab exists. Ending the trace clears the flag, and the pane
  // falls back to the session's stored state: a collapsed pane is collapsed
  // again, an open pane stays open on its previous app tab.
  // - The pane's collapse button clears the flag and collapses for real. The
  //   tab stays, and expanding shows it again.
  // - Choosing an app tab or adding an app expands the pane for real, through
  //   the store, because the user has moved on to the pane. The flag is then
  //   redundant and clears, so the app stays visible after the trace closes.
  //
  // The Tasks tab is the same kind of tab: view state, never saved, at most
  // one. At most one built-in tab is selected, and a built-in tab opened over a
  // collapsed pane holds it open with the same flag, until the last of them
  // closes.
  const [trace, setTrace] = useState<{ owner: string; streaming: boolean } | null>(null);
  const [selected, setSelected] = useState<BuiltinTab | null>(null);
  // The Concierge chat whose task list the tab shows; null while it is not open.
  const [tasksChatId, setTasksChatId] = useState<string | null>(null);
  const tasksOpen = tasksChatId !== null;
  // The chat whose outputs the tab shows, and the output it was opened on.
  const [outputsTarget, setOutputsTarget] = useState<{
    chatId: string;
    outputId: string | null;
    /** Counts each opening, so opening the same output again chooses it again. */
    seq: number;
    taskChats: boolean;
  } | null>(null);
  const outputsOpen = outputsTarget !== null;
  const [holdsOpen, setHoldsOpen] = useState(false);
  const traceOwnerRef = useRef<string | null>(null);
  const traceCloseRef = useRef<(() => void) | null>(null);
  const latest = useRef({ view, setCollapsed });
  latest.current = { view, setCollapsed };

  const reveal = useCallback(() => {
    if (latest.current.view.collapsed) setHoldsOpen(true);
    setSelected("trace");
  }, []);

  const setTraceTab = useCallback(
    (owner: string, tab: ToolTraceTab | null) => {
      if (tab === null) {
        if (traceOwnerRef.current !== owner) return;
        traceOwnerRef.current = null;
        traceCloseRef.current = null;
        setSelected((current) => (current === "trace" ? null : current));
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
    if (activations !== undefined) setSelected(null);
  }, [activations]);

  function addAndShow(type: WidgetType, targetId?: string) {
    setSelected(null);
    addWidget(type, targetId);
  }

  // A real expansion supersedes the hold.
  useEffect(() => {
    if (!view.collapsed) setHoldsOpen(false);
  }, [view.collapsed]);

  const builtinOpen = trace !== null || tasksOpen || outputsOpen;
  // The hold ends with the last built-in tab: the pane falls back to the
  // session's stored state.
  useEffect(() => {
    if (!builtinOpen) setHoldsOpen(false);
  }, [builtinOpen]);
  const open = !view.collapsed || (builtinOpen && holdsOpen);
  const setPaneCollapsed = useCallback((collapsed: boolean) => {
    setHoldsOpen(false);
    latest.current.setCollapsed(collapsed);
  }, []);

  const traceActive = trace !== null && selected === "trace";
  const tasksActive = tasksOpen && selected === "tasks";
  const outputsActive = outputsOpen && selected === "outputs";
  const builtinActive = traceActive || tasksActive || outputsActive;
  const traceHost = useMemo<ToolTraceHost>(
    () => ({ outlet, paneOpen: open, setPaneCollapsed, reveal, set: setTraceTab }),
    [outlet, open, setPaneCollapsed, reveal, setTraceTab],
  );
  const sorted = [...placements].sort((a, b) => a.order - b.order);
  const hasTabs = sorted.length > 0 || builtinOpen;
  const compact = width < COMPACT_WIDTH;
  const showTasks = useCallback((chatId: string) => {
    if (latest.current.view.collapsed) setHoldsOpen(true);
    setTasksChatId(chatId);
    setSelected("tasks");
  }, []);
  const hideTasks = useCallback(() => {
    setTasksChatId(null);
    setSelected((current) => (current === "tasks" ? null : current));
  }, []);
  const tasksHost = useMemo<ToolTasksHost>(
    () => ({
      active: tasksActive && open,
      compact,
      show: showTasks,
      hide: hideTasks,
    }),
    [tasksActive, open, compact, showTasks, hideTasks],
  );
  const showOutputs = useCallback(
    (chatId: string, outputId?: string, options?: OutputsTabOptions) => {
      if (latest.current.view.collapsed) setHoldsOpen(true);
      setOutputsTarget((prev) => ({
        chatId,
        outputId: outputId ?? null,
        seq: (prev?.seq ?? 0) + 1,
        taskChats: options?.taskChats === true,
      }));
      setSelected("outputs");
    },
    [],
  );
  const hideOutputs = useCallback(() => {
    setOutputsTarget(null);
    setSelected((current) => (current === "outputs" ? null : current));
  }, []);
  // The tab's own close settles a file being edited in it first.
  const outputsLeaveGuard: LeaveGuard = useRef(null);
  const closeOutputsTab = useCallback(
    () => leaveEditor(outputsLeaveGuard, hideOutputs),
    [hideOutputs],
  );
  const outputsHost = useMemo<ToolOutputsHost>(
    () => ({ active: outputsActive && open, compact, show: showOutputs, hide: hideOutputs }),
    [outputsActive, open, compact, showOutputs, hideOutputs],
  );
  const activeWidget = builtinActive
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

  // The strip is a state-held element, not a ref, because the title bar portal
  // and the in-pane header swap it for a new one.
  useEffect(() => {
    if (!strip) return;
    const observer = new ResizeObserver(([entry]) => setStripWidth(entry.contentRect.width));
    observer.observe(strip);
    return () => observer.disconnect();
  }, [strip]);

  // What each tab's name measures in the hidden row, and what a drawn tab adds
  // around its name (padding, close button), read from one on screen.
  const [tabWidths, setTabWidths] = useState<{ names: Record<string, number>; chrome: number }>({
    names: {},
    chrome: 0,
  });
  const [measure, setMeasure] = useState<HTMLDivElement | null>(null);
  // Both sides are measured the same way, from what a tab holds: its name and
  // its own dots. The chrome is a drawn tab less all it holds, so it is the
  // same whichever tab is drawn; were it read with one tab's dot in it, the
  // tabs that fit would change it, and it them, without end.
  useLayoutEffect(() => {
    if (!measure) return;
    const names: Record<string, number> = {};
    for (const el of measure.querySelectorAll<HTMLElement>("[data-measure-tab]")) {
      names[el.dataset.measureTab!] = Math.ceil(contentWidth(el));
    }
    const tab = strip?.querySelector<HTMLElement>("[data-tool-tab]");
    const trigger = tab?.querySelector<HTMLElement>("[role=tab]");
    const chrome =
      tab && trigger ? Math.ceil(tab.getBoundingClientRect().width - contentWidth(trigger)) : 0;
    setTabWidths((prev) =>
      prev.chrome === chrome && JSON.stringify(prev.names) === JSON.stringify(names)
        ? prev
        : { names, chrome },
    );
  });

  // In the Mac app the tabs move up into the title bar, over this panel, so the
  // window has one row on top. The header there is as wide as the panel.
  const inTitlebar = useSlotOutlet(TITLEBAR_END_SLOT);
  const toolsWidth = compact ? width : Math.max(0, width - chatWidth - SEPARATOR_WIDTH);
  // The tabs keep the `Tabs` root's context through the portal, but not its
  // CSS group, so the list states its full height itself. The kit's own list
  // height is shorter than a tab, so inside the group the list takes the row's
  // height too, or it would clip the tabs. The strip never scrolls: tabs that
  // do not fit at their minimum width leave it, and the all-tools menu lists
  // them. The same `header` renders in the title bar, so both share this.
  const tabIds = [
    ...(trace ? [TRACE_TAB_ID] : []),
    ...(tasksOpen ? [TASKS_TAB_ID] : []),
    ...(outputsOpen ? [OUTPUTS_TAB_ID] : []),
    ...sorted.map((widget) => widget.id),
  ];
  const builtinTabId = traceActive
    ? TRACE_TAB_ID
    : tasksActive
      ? TASKS_TAB_ID
      : outputsActive
        ? OUTPUTS_TAB_ID
        : null;
  const activeTabId = builtinTabId ?? view.activeId ?? null;
  // Each tab's name, which the measuring row below draws for every tab, the
  // ones in the menu too, so the strip knows each tab's own width.
  // Which tabs carry a dot after their name: the trace while it streams, an
  // app with an update.
  const tabDots = new Set([
    ...(trace?.streaming ? [TRACE_TAB_ID] : []),
    ...sorted.filter((widget) => view.unreadIds.includes(widget.id)).map((widget) => widget.id),
  ]);
  const tabLabels: Record<string, string> = {
    ...(trace ? { [TRACE_TAB_ID]: tActivity("trace.drawer.title") } : {}),
    ...(tasksOpen ? { [TASKS_TAB_ID]: t("chat.tasksTab") } : {}),
    ...(outputsOpen ? { [OUTPUTS_TAB_ID]: tChat("outputs.title") } : {}),
    ...Object.fromEntries(sorted.map((widget) => [widget.id, label(widget)])),
  };
  const shownIds = new Set(
    fitTabs(tabIds, activeTabId, stripWidth, (id) =>
      tabWidths.names[id]
        ? Math.min(tabWidths.names[id], MAX_TAB_CONTENT_WIDTH) + tabWidths.chrome
        : 0,
    ),
  );
  const hiddenCount = tabIds.length - shownIds.size;
  const allToolsLabel =
    hiddenCount > 0 ? t("chat.allToolsHidden", { count: hiddenCount }) : t("chat.allTools");
  const header = (
    <>
      {hasTabs ? (
        <TabsList
          ref={setStrip}
          aria-label={t("chat.tools")}
          className="h-full min-w-0 flex-1 justify-start overflow-hidden group-data-horizontal/tabs:h-full p-0"
        >
          {trace && shownIds.has(TRACE_TAB_ID) && (
            <ToolTab
              id={TRACE_TAB_ID}
              label={tActivity("trace.drawer.title")}
              active={traceActive}
              liveLabel={trace.streaming ? tActivity("trace.drawer.live") : undefined}
              onClose={() => traceCloseRef.current?.()}
            />
          )}
          {tasksOpen && shownIds.has(TASKS_TAB_ID) && (
            <ToolTab
              id={TASKS_TAB_ID}
              label={t("chat.tasksTab")}
              active={tasksActive}
              onClose={hideTasks}
            />
          )}
          {outputsOpen && shownIds.has(OUTPUTS_TAB_ID) && (
            <ToolTab
              id={OUTPUTS_TAB_ID}
              label={tChat("outputs.title")}
              active={outputsActive}
              onClose={closeOutputsTab}
            />
          )}
          {sorted
            .filter((widget) => shownIds.has(widget.id))
            .map((widget) => (
              <ToolTab
                key={widget.id}
                id={widget.id}
                label={label(widget)}
                active={!builtinActive && widget.id === view.activeId}
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
            {hiddenCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={allToolsLabel}
                title={allToolsLabel}
                className="shrink-0"
              >
                <ChevronDown />
                <span className="text-aux tabular-nums">+{hiddenCount}</span>
              </Button>
            ) : (
              <IconButton size="sm" label={allToolsLabel} icon={<ChevronDown />} />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {trace && (
              <DropdownMenuItem onSelect={() => pickTab(TRACE_TAB_ID)}>
                <ListTree className="size-3.5" />
                {tActivity("trace.drawer.title")}
              </DropdownMenuItem>
            )}
            {tasksOpen && (
              <DropdownMenuItem onSelect={() => pickTab(TASKS_TAB_ID)}>
                <ListChecks className="size-3.5" />
                {t("chat.tasksTab")}
              </DropdownMenuItem>
            )}
            {outputsOpen && (
              <DropdownMenuItem onSelect={() => pickTab(OUTPUTS_TAB_ID)}>
                <FileOutput className="size-3.5" />
                {tChat("outputs.title")}
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
    if (id === TRACE_TAB_ID) return setSelected("trace");
    if (id === TASKS_TAB_ID) return setSelected("tasks");
    if (id === OUTPUTS_TAB_ID) return setSelected("outputs");
    setSelected(null);
    selectTool(id);
  }

  function changeRatio(next: number) {
    const constrained = Math.max(0.2, Math.min(0.8, next));
    setRatio(constrained);
    writeStored(WIDTH_KEY, String(constrained));
  }

  const edge = usePaneResize({
    size: chatWidth,
    min: MIN_PANE_WIDTH,
    max: available - MIN_PANE_WIDTH,
    onResize: (next) => changeRatio(next / available),
    onReset: () => changeRatio(DEFAULT_RATIO),
  });
  const resizing = edge.resizing;

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
        {/* Every tab's name at the strip's type, out of sight, for its width. */}
        <div
          ref={setMeasure}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex"
        >
          {Object.entries(tabLabels).map(([id, name]) => (
            // As a tab's trigger holds it: the name, then its dot.
            <span key={id} data-measure-tab={id} className="flex gap-1 text-ui whitespace-nowrap">
              <span data-measure-label>{name}</span>
              {tabDots.has(id) ? <span className="size-1.5 shrink-0" /> : null}
            </span>
          ))}
        </div>
        <div
          className="relative flex min-h-0 min-w-0 flex-col"
          data-testid="workspace-chat"
          style={{
            display: compact && open ? "none" : undefined,
            width: open && !compact ? chatWidth : "100%",
            flexShrink: 0,
          }}
        >
          <ToolTasksContext.Provider value={tasksHost}>
            <ToolOutputsContext.Provider value={outputsHost}>
              {children}
            </ToolOutputsContext.Provider>
          </ToolTasksContext.Provider>
        </div>
        {open && !compact && (
          <div
            {...edge.separatorProps}
            aria-label={t("chat.resizeTools")}
            className="relative z-40 w-px shrink-0 cursor-col-resize touch-none before:absolute before:inset-y-0 before:-inset-x-1 after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border-subtle after:transition-[width] hover:after:w-1 focus-visible:outline-ring/50 focus-visible:after:w-1 data-[resizing]:after:w-1"
          />
        )}
        <Tabs
          value={builtinTabId ?? view.activeId ?? ""}
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
            {placements.length === 0 && !builtinActive && (
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
                  inert={builtinActive || widget.id !== view.activeId}
                  aria-hidden={builtinActive || widget.id !== view.activeId}
                  style={{
                    display: !builtinActive && widget.id === view.activeId ? undefined : "none",
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
            {tasksOpen && (
              <TabsContent
                value={TASKS_TAB_ID}
                forceMount
                inert={!tasksActive}
                aria-hidden={!tasksActive}
                style={{ display: tasksActive ? undefined : "none" }}
                className="absolute inset-0 overflow-hidden"
              >
                {tasksChatId ? (
                  <div className="h-full overflow-y-auto pb-safe">
                    <TaskList chatId={tasksChatId} />
                  </div>
                ) : null}
              </TabsContent>
            )}
            {outputsTarget && (
              <TabsContent
                value={OUTPUTS_TAB_ID}
                forceMount
                inert={!outputsActive}
                aria-hidden={!outputsActive}
                style={{ display: outputsActive ? undefined : "none" }}
                className="absolute inset-0 overflow-hidden"
              >
                <OutputsPanel
                  key={outputsTarget.chatId}
                  chatId={outputsTarget.chatId}
                  selectedId={outputsTarget.outputId}
                  selectionSeq={outputsTarget.seq}
                  leaveGuard={outputsLeaveGuard}
                  taskChats={outputsTarget.taskChats}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
        {resizing && <div className="absolute inset-0 z-30 cursor-col-resize" />}
      </div>
    </ToolTraceContext.Provider>
  );
}
