import { ChevronDown, LayoutGrid, PanelRightClose, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import type { ToolView, WidgetPlacement, WidgetType } from "./use-free-cells";

const WIDTH_KEY = "rome:tool-chat-ratio";
const DEFAULT_RATIO = 0.4;
const MIN_PANE_WIDTH = 360;
const COMPACT_WIDTH = MIN_PANE_WIDTH * 2 + 8;

function readRatio() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    if (value >= 0.2 && value <= 0.8) return value;
  } catch {}
  return DEFAULT_RATIO;
}

interface ToolTabProps {
  widget: WidgetPlacement;
  label: string;
  icon: ReactNode;
  active: boolean;
  unread: boolean;
  onClose: () => void;
}

function ToolTab({ widget, label, icon, active, unread, onClose }: ToolTabProps) {
  const { t } = useTranslation("common");
  const tabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (active) tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div ref={tabRef} className="relative flex h-10 shrink-0 items-center gap-1">
      <TabsTrigger
        value={widget.id}
        role="tab"
        aria-selected={active}
        title={label}
        className="max-w-48 gap-2 group-data-horizontal/tabs:after:bottom-0"
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
  children,
}: ToolWorkspaceProps) {
  const { t } = useTranslation("common");
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(readRatio);
  const [resizing, setResizing] = useState(false);
  const sorted = [...placements].sort((a, b) => a.order - b.order);
  const compact = width < COMPACT_WIDTH;
  const open = !view.collapsed;
  const available = Math.max(0, width - 8);
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
          className="z-40 w-2 shrink-0 cursor-col-resize touch-none border-x border-border-subtle hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring"
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
              Math.max(MIN_PANE_WIDTH, Math.min(available - MIN_PANE_WIDTH, event.clientX - left)) /
                available,
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
        value={view.activeId ?? ""}
        onValueChange={selectTool}
        activationMode="automatic"
        className="min-h-0 min-w-0 flex-1 gap-0 bg-background"
        style={{ display: open ? undefined : "none" }}
      >
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          {sorted.length > 0 ? (
            <TabsList
              aria-label={t("chat.tools")}
              className="min-w-0 flex-1 justify-start overflow-x-auto p-0 group-data-horizontal/tabs:h-full"
            >
              {sorted.map((widget) => (
                <ToolTab
                  key={widget.id}
                  widget={widget}
                  label={label(widget)}
                  icon={icon(widget)}
                  active={widget.id === view.activeId}
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
          {sorted.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label={t("chat.allTools")} icon={<ChevronDown />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {sorted.map((widget) => (
                  <DropdownMenuItem key={widget.id} onSelect={() => selectTool(widget.id)}>
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
          {sorted.length > 0 && (
            <WidgetPicker onSelect={addWidget} placements={placements}>
              <IconButton size="sm" data-coach="add-widget" label={t("chat.add")} icon={<Plus />} />
            </WidgetPicker>
          )}
          <IconButton
            size="sm"
            className="max-md:hidden"
            label={t("chat.collapseTools")}
            aria-expanded={true}
            icon={<PanelRightClose />}
            onClick={() => setCollapsed(true)}
          />
        </div>
        <div className="relative min-h-0 flex-1">
          {placements.length === 0 && (
            <EmptyState className="h-full" role="region">
              <EmptyStateIcon>
                <LayoutGrid />
              </EmptyStateIcon>
              <EmptyStateTitle>{t("chat.emptyAppsTitle")}</EmptyStateTitle>
              <EmptyStateDescription>{t("chat.emptyAppsDescription")}</EmptyStateDescription>
              <EmptyStateAction>
                <WidgetPicker onSelect={addWidget}>
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
                inert={widget.id !== view.activeId}
                aria-hidden={widget.id !== view.activeId}
                style={{ display: widget.id === view.activeId ? undefined : "none" }}
                className="absolute inset-0 overflow-auto overscroll-y-contain pb-safe md:pb-0"
              >
                {content(widget, resizing)}
              </TabsContent>
            ))}
        </div>
      </Tabs>
      {resizing && <div className="absolute inset-0 z-30 cursor-col-resize" />}
    </div>
  );
}
