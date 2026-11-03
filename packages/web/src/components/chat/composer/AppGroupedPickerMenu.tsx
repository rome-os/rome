import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { RomeLogo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { CHAT_POPOVER_FIT } from "@/components/chat/chat-overlay";

/**
 * One left-panel row: an app (or core) that owns pickable items. The
 * description must arrive pre-resolved (including any "N items" count
 * fallback) — the picker renders it verbatim in the header slot.
 */
export interface PickerGroup<TItem> {
  ownerId: string;
  label: string;
  description: string;
  iconUrl: string | null;
  items: TItem[];
}

export interface AppGroupedPickerMenuHandle {
  // Called from the textarea's onKeyDown to navigate the menu without
  // surrendering input focus.
  move: (delta: 1 | -1) => void;
  moveHorizontal: (delta: 1 | -1) => void;
  acceptSelected: () => boolean;
}

export interface AppGroupedPickerMenuProps<TItem> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Filter string — observed only to snap panel focus back to apps when it
  // changes; the adapter applies the actual filtering to `groups`.
  query: string;
  // Rendered as the popover anchor — typically a wrapper around the textarea.
  anchor: React.ReactNode;
  // Static header line telling the user what this menu picks.
  title: string;
  loading: boolean;
  loadingText: string;
  error: string | null;
  // Shown when `groups` is empty — the adapter picks empty-catalog vs no-match.
  emptyText: string;
  // Right-panel hint for the transient frame before a group is highlighted.
  pickGroupText: string;
  // Already filtered + ordered by the adapter.
  groups: Array<PickerGroup<TItem>>;
  getItemKey: (item: TItem) => string;
  renderItemLabel: (item: TItem) => React.ReactNode;
  getItemDescription: (item: TItem) => string;
  onSelect: (group: PickerGroup<TItem>, item: TItem) => void;
}

/**
 * Two-panel app → item picker anchored to the chat composer: the shared
 * interaction core of the `@` agent mention menu and the `/` skill menu
 * (and any future composer picker). Owns the keyboard state machine
 * (vertical move, ArrowRight drill-in, two-step Enter), highlight-follows-
 * mouse, scroll-into-view, and the header slot that explains what is being
 * picked plus the highlighted row's description. Adapters own data fetching,
 * filtering, strings, and the selection payload.
 */
function AppGroupedPickerMenuInner<TItem>(
  {
    open,
    onOpenChange,
    query,
    anchor,
    title,
    loading,
    loadingText,
    error,
    emptyText,
    pickGroupText,
    groups,
    getItemKey,
    renderItemLabel,
    getItemDescription,
    onSelect,
  }: AppGroupedPickerMenuProps<TItem>,
  ref: React.ForwardedRef<AppGroupedPickerMenuHandle>,
) {
  // Which panel keyboard nav targets. Right panel is only reachable once
  // we've highlighted at least one app.
  const [focusedPanel, setFocusedPanel] = useState<"groups" | "items">("groups");
  const [groupIdx, setGroupIdx] = useState(0);
  const [itemIdx, setItemIdx] = useState(0);
  const groupsScrollRef = useRef<HTMLDivElement>(null);
  const itemsScrollRef = useRef<HTMLDivElement>(null);

  const activeGroup = groups[groupIdx] ?? null;
  // Guarded lookups: both indexes can be transiently out of range for one
  // render after the filter shrinks a list, before the clamping effects run.
  const activeItem = focusedPanel === "items" ? activeGroup?.items[itemIdx] : undefined;
  const headerDescription =
    focusedPanel === "items"
      ? activeItem !== undefined
        ? getItemDescription(activeItem)
        : ""
      : (activeGroup?.description ?? "");

  // Reset selection state whenever the visible list changes shape — keeps
  // both indexes in range and snaps focus back to the apps panel when a
  // new filter erases the previous right-panel context.
  useEffect(() => {
    setGroupIdx((prev) => (prev >= groups.length ? 0 : prev));
  }, [groups.length]);
  useEffect(() => {
    setItemIdx(0);
  }, [groupIdx, query]);
  useEffect(() => {
    // Whenever the filter changes, snap focus back to apps. Avoids the
    // confusing state where the item panel still claims focus but the
    // active app underneath has silently changed.
    setFocusedPanel("groups");
  }, [query]);
  useEffect(() => {
    if (!open) {
      setFocusedPanel("groups");
      setGroupIdx(0);
      setItemIdx(0);
    }
  }, [open]);

  // Scroll the highlighted row into view whenever it changes. Required for
  // long lists — without this the popover never scrolls and the user can
  // hit ArrowDown into invisible items.
  useEffect(() => {
    const container = groupsScrollRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-group-idx="${groupIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [groupIdx]);
  useEffect(() => {
    const container = itemsScrollRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-item-idx="${itemIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [itemIdx, groupIdx]);

  useImperativeHandle(
    ref,
    () => ({
      move: (delta) => {
        if (focusedPanel === "groups") {
          if (groups.length === 0) return;
          setGroupIdx((prev) => {
            const next = prev + delta;
            if (next < 0) return groups.length - 1;
            if (next >= groups.length) return 0;
            return next;
          });
        } else {
          const items = activeGroup?.items ?? [];
          if (items.length === 0) return;
          setItemIdx((prev) => {
            const next = prev + delta;
            if (next < 0) return items.length - 1;
            if (next >= items.length) return 0;
            return next;
          });
        }
      },
      moveHorizontal: (delta) => {
        if (delta > 0) {
          // ArrowRight: jump from apps → items (if the focused app has any).
          if (focusedPanel === "groups" && (activeGroup?.items.length ?? 0) > 0) {
            setFocusedPanel("items");
            setItemIdx(0);
          }
        } else if (focusedPanel === "items") {
          setFocusedPanel("groups");
        }
      },
      acceptSelected: () => {
        if (focusedPanel === "groups") {
          // Two-step UX: first Enter on an app drills into its items.
          if (!activeGroup || activeGroup.items.length === 0) return false;
          setFocusedPanel("items");
          setItemIdx(0);
          return true;
        }
        const item = activeGroup?.items[itemIdx];
        if (!activeGroup || item === undefined) return false;
        onSelect(activeGroup, item);
        return true;
      },
    }),
    [focusedPanel, groups, activeGroup, itemIdx, onSelect],
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={10}
        collisionPadding={CHAT_POPOVER_FIT.collisionPadding}
        className={cn(
          "max-h-(--radix-popover-content-available-height) w-96 gap-0 p-0",
          CHAT_POPOVER_FIT.className,
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {error ? (
          <div className="px-3 py-2 text-aux text-destructive-fg">{error}</div>
        ) : loading ? (
          <div className="px-3 py-2 text-aux text-subtle-foreground">{loadingText}</div>
        ) : groups.length === 0 ? (
          <div className="py-6 text-center text-ui text-subtle-foreground">{emptyText}</div>
        ) : (
          <>
            {/* Header slot: a static title naming what this menu picks, then
                one truncated line with the highlighted row's description —
                the group's while the left panel has focus, the item's once
                focus moves right. Both lines are fixed-height (min-h keeps
                the second one when the description is empty), so navigating
                never resizes or shifts the menu. */}
            <div className="shrink-0 border-b border-border px-2 py-2">
              <div className="text-aux">{title}</div>
              <div className="mt-1 min-h-4 truncate text-aux text-muted-foreground">
                {headerDescription}
              </div>
            </div>
            {/* Flex (not grid): with the popover capped at the available
                height above the composer, min-h-0 lets both panes shrink and
                scroll internally instead of the top of the menu (the title)
                being clipped at the viewport edge. */}
            <div className="flex min-h-0 divide-x divide-border">
              {/* ---- Left: apps ---- */}
              <div
                ref={groupsScrollRef}
                className="max-h-72 min-h-0 w-1/2 overflow-y-auto overflow-x-hidden p-1"
              >
                {groups.map((group, idx) => {
                  const isSelected = idx === groupIdx;
                  const dim = focusedPanel === "items" && !isSelected;
                  return (
                    <div
                      key={group.ownerId}
                      role="option"
                      aria-selected={isSelected}
                      data-group-idx={idx}
                      onMouseEnter={() => setGroupIdx(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setGroupIdx(idx);
                        setFocusedPanel("items");
                        setItemIdx(0);
                      }}
                      className={
                        "relative flex cursor-default select-none items-center gap-2 rounded-8 px-2 py-1 text-ui outline-none " +
                        (isSelected ? "bg-accent text-accent-foreground" : dim ? "opacity-60" : "")
                      }
                    >
                      {group.iconUrl ? (
                        <img src={group.iconUrl} alt="" className="size-5 shrink-0 rounded-4" />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex size-5 shrink-0 items-center justify-center rounded-4 bg-surface-muted text-foreground"
                        >
                          <RomeLogo className="size-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <ChevronRight
                        aria-hidden="true"
                        className={
                          "size-3.5 shrink-0 " +
                          (isSelected ? "text-accent-foreground" : "text-muted-foreground")
                        }
                      />
                    </div>
                  );
                })}
              </div>
              {/* ---- Right: items of the focused app ---- */}
              <div
                ref={itemsScrollRef}
                className="max-h-72 min-h-0 w-1/2 overflow-y-auto overflow-x-hidden p-1"
              >
                {activeGroup ? (
                  activeGroup.items.map((item, idx) => {
                    const isSelected = focusedPanel === "items" && idx === itemIdx;
                    return (
                      <div
                        key={getItemKey(item)}
                        role="option"
                        aria-selected={isSelected}
                        data-item-idx={idx}
                        onMouseEnter={() => setItemIdx(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onSelect(activeGroup, item);
                        }}
                        className={
                          "relative flex cursor-default select-none items-center rounded-8 px-2 py-1 text-ui outline-none " +
                          (isSelected ? "bg-accent text-accent-foreground" : "")
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">{renderItemLabel(item)}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="px-2 py-2 text-aux text-subtle-foreground">{pickGroupText}</div>
                )}
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// forwardRef erases the generic; this cast restores it for callers while
// keeping the ref prop typed. Standard pattern for generic forwardRef
// components.
export const AppGroupedPickerMenu = forwardRef(AppGroupedPickerMenuInner) as <TItem>(
  props: AppGroupedPickerMenuProps<TItem> & { ref?: React.Ref<AppGroupedPickerMenuHandle> },
) => React.ReactElement;
