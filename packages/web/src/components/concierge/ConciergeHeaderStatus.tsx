import { BrainCircuit, FileOutput, ListChecks } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { RomeMascot } from "./RomeMascot";

/** The kinds that are work under way, whose status line shimmers. */
const WORKING = new Set<ConciergeActivity["kind"]>(["working", "tool", "tasks"]);

/**
 * The translucent surface every piece of a Concierge chat's floating header
 * sits on: the mascot's badge, the name tag, the status capsule and the round
 * buttons. It blurs
 * the messages scrolling under it, so its text stays readable without a bar.
 */
export const FLOATING_SURFACE =
  "border border-border/60 bg-surface/95 shadow-1 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80";

/**
 * The phone's leading buttons (back to the chat list, the menu), which the
 * shell moves into a Concierge chat's floating header while it shows one.
 */
export const CONCIERGE_LEADING_SLOT = "conciergeHeaderLeading";

/**
 * Where the Mac app's title bar takes a Concierge chat's mascot, name and status, to
 * hang them from its lower edge over the chat.
 */
export const CONCIERGE_TITLEBAR_SLOT = "conciergeTitlebar";

/**
 * The middle of a Concierge chat's floating header, centred top to bottom: the
 * mascot in a round badge, a small name tag overlapping the badge's lower
 * edge, and under it, a capsule with what the Concierge is doing right now.
 * The name and the status are separate, so a short name stays under the
 * mascot whatever the status's length. Idle, the status capsule is gone, and
 * the mascot only blinks. The status line is a live region, so a screen
 * reader hears it change; idle, it stays in the page, read but not drawn.
 *
 * Its root lays out as `contents`: the pieces are items of the header's grid.
 * The badge takes the first row, where the side buttons centre on it, and
 * the name tag the second. The status takes the third, across all three
 * columns, so its width is a share of the header's and does not widen the
 * middle column the buttons are placed around. Without the badge, the name
 * tag takes the first row and the status the second.
 */
export function ConciergeHeaderStatus({
  name,
  activity,
  badge = true,
  onOpenTasks,
  onOpenOutputs,
  onOpenMemory,
}: {
  name: ReactNode;
  activity: ConciergeActivity;
  /** Whether the mascot's badge shows. Without it the name tag takes the badge's row. */
  badge?: boolean;
  /**
   * Opens the chat's task list. The badge is its button, or the name tag
   * while the badge is gone.
   */
  onOpenTasks?: () => void;
  /** Opens the chat's outputs. With it and `onOpenMemory`, the badge has a quick menu. */
  onOpenOutputs?: () => void;
  /** Opens the memory browser. */
  onOpenMemory?: () => void;
}) {
  const { t } = useTranslation("chat");
  const status = statusText(activity, t);
  const busy = activity.kind !== "idle";
  const openLabel = t("concierge.taskList.open");
  // The badge opens the task list, or the name tag while the badge is gone.
  const opensFromBadge = Boolean(onOpenTasks) && badge;
  const opensFromName = Boolean(onOpenTasks) && !badge;
  const quickMenu =
    opensFromBadge && onOpenOutputs && onOpenMemory
      ? { tasks: onOpenTasks!, outputs: onOpenOutputs, memory: onOpenMemory }
      : null;
  const Badge = opensFromBadge ? "button" : "div";
  const NameTag = opensFromName ? "button" : "div";
  const opener = (here: boolean) =>
    here
      ? {
          type: "button" as const,
          onClick: onOpenTasks,
          "aria-label": openLabel,
          title: openLabel,
        }
      : {};
  const focusRing =
    "cursor-pointer outline-none outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";
  return (
    <div data-concierge-header-status data-activity={activity.kind} className="contents">
      {badge ? (
        quickMenu ? (
          <QuickMenu items={quickMenu}>
            {(menuProps) => (
              <Badge
                data-concierge-header-badge
                {...opener(opensFromBadge)}
                {...menuProps}
                // The menu names what the badge opens, so no tooltip covers it.
                title={undefined}
                className={cn(
                  "pointer-events-auto col-start-2 row-start-1 flex size-11 items-center justify-center justify-self-center rounded-full",
                  FLOATING_SURFACE,
                  focusRing,
                )}
              >
                <RomeMascot
                  alive={busy && activity.kind !== "needsYou"}
                  className="h-6.5 w-auto cursor-pointer"
                />
              </Badge>
            )}
          </QuickMenu>
        ) : (
          <Badge
            data-concierge-header-badge
            {...opener(opensFromBadge)}
            className={cn(
              "pointer-events-auto col-start-2 row-start-1 flex size-11 items-center justify-center justify-self-center rounded-full",
              FLOATING_SURFACE,
              opensFromBadge && focusRing,
            )}
          >
            {/* About 60% of the badge, so the bob and the squash keep inside it. */}
            <RomeMascot
              alive={busy && activity.kind !== "needsYou"}
              className={cn("h-6.5 w-auto", opensFromBadge && "cursor-pointer")}
            />
          </Badge>
        )
      ) : null}
      <NameTag
        data-concierge-header-name
        {...opener(opensFromName)}
        className={cn(
          opensFromName && focusRing,
          badge ? "row-start-2 -mt-1" : "row-start-1",
          // Above the badge, so the tag covers the badge's edge, not the reverse.
          "pointer-events-auto relative z-10 col-start-2 flex h-5 min-w-0 max-w-full items-center justify-self-center rounded-full px-2",
          FLOATING_SURFACE,
        )}
      >
        {/* Eight CJK characters at the tag's own size, then an ellipsis. */}
        <span className="max-w-[8em] truncate text-aux font-medium text-foreground">{name}</span>
      </NameTag>
      <div
        data-concierge-header-activity
        aria-live="polite"
        className={cn(
          badge ? "row-start-3" : "row-start-2",
          "col-span-3 col-start-1 mt-1 flex h-6 min-w-0 max-w-[70%] items-center justify-self-center rounded-full px-3",
          status ? cn("pointer-events-auto", FLOATING_SURFACE) : "sr-only",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-aux text-muted-foreground",
            // A light band sweeps the line while work is under way; a
            // question waiting on the owner and idle stay still.
            WORKING.has(activity.kind) && "shimmer",
          )}
        >
          {status ?? t("concierge.activity.idle")}
        </span>
      </div>
    </div>
  );
}

function statusText(
  activity: ConciergeActivity,
  t: ReturnType<typeof useTranslation<"chat">>["t"],
): string | null {
  switch (activity.kind) {
    case "idle":
      return null;
    case "needsYou":
      return t("concierge.activity.needsYou");
    case "working":
      return t("concierge.activity.working");
    case "tool":
      return t(`concierge.activity.tool.${activity.tool}`);
    case "tasks":
      return activity.more > 0
        ? t("concierge.activity.tasksMore", { title: activity.title, count: activity.more })
        : t("concierge.activity.tasks", { title: activity.title });
  }
}

// How long the pointer may be off both the badge and the menu before it closes,
// so it can cross the gap between them.
const LEAVE_DELAY_MS = 150;

type BadgeMenuProps = {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
};

/**
 * The badge's quick menu: Tasks, Outputs and Memory, each opening its tab in
 * the side pane. Hovering the badge shows it, a tap shows it where nothing
 * hovers, and Arrow Down shows it from the keyboard. A click on the badge
 * itself still opens Tasks. It holds no counts or marks.
 */
function QuickMenu({
  items,
  children,
}: {
  items: { tasks: () => void; outputs: () => void; memory: () => void };
  children: (props: BadgeMenuProps) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const touched = useRef(false);
  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const leave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setOpen(false), LEAVE_DELAY_MS);
  };
  useEffect(() => cancelLeave, []);
  const choose = (open: () => void) => {
    setOpen(false);
    open();
  };
  const badgeProps: BadgeMenuProps = {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onPointerDown: (event) => {
      touched.current = event.pointerType === "touch";
    },
    onPointerEnter: (event) => {
      if (event.pointerType !== "mouse") return;
      cancelLeave();
      setOpen(true);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse") leave();
    },
    onClick: (event) => {
      // A tap shows the menu: there is no hover to show it.
      if (touched.current) {
        touched.current = false;
        event.preventDefault();
        setOpen((was) => !was);
        return;
      }
      setOpen(false);
      items.tasks();
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
      }
    },
  };
  const entries = [
    { key: "tasks", icon: <ListChecks />, label: t("concierge.menu.tasks"), run: items.tasks },
    {
      key: "outputs",
      icon: <FileOutput />,
      label: t("concierge.menu.outputs"),
      run: items.outputs,
    },
    { key: "memory", icon: <BrainCircuit />, label: t("concierge.menu.memory"), run: items.memory },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor asChild>{children(badgeProps)}</PopoverAnchor>
      <PopoverContent
        role="menu"
        aria-label={t("concierge.menu.label")}
        side="right"
        align="start"
        sideOffset={8}
        // Hover opens it, so focus stays where it was; Arrow Down moves in.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelLeave}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") leave();
        }}
        className="w-auto min-w-40 gap-0.5 p-1"
      >
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            data-concierge-menu-item={entry.key}
            onClick={() => choose(entry.run)}
            className="flex h-[var(--control-h-md)] w-full cursor-pointer items-center gap-2 rounded-8 px-2 text-left text-ui text-foreground outline-none outline-1 -outline-offset-1 outline-transparent hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
