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

/** One entry of the header's quick menu: what it opens, never a count or a mark. */
export interface HeaderMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  run: () => void;
}

/** The header's quick menu, opened from its badge. */
export interface HeaderMenu {
  items: HeaderMenuItem[];
  /** A quiet line at the menu's foot, such as the model that last answered. */
  caption?: ReactNode;
}

/**
 * The middle of a chat's floating header, centred top to bottom: the agent in
 * a round badge, a small name tag overlapping the badge's lower edge, and, in
 * a Concierge chat, a capsule under it with what the Concierge is doing right
 * now. The name and the status are separate, so a short name stays under the
 * badge whatever the status's length. Idle, the status capsule is gone, and
 * the mascot only blinks. The status line is a live region, so a screen
 * reader hears it change; idle, it stays in the page, read but not drawn.
 *
 * The badge is no action of its own: hovering it, or a click or tap, shows its
 * `menu`. Without the badge, the name tag shows it.
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
  activity = { kind: "idle" },
  badge = true,
  avatar,
  menu,
}: {
  name: ReactNode;
  /** What the Concierge is doing; an ordinary chat leaves it idle. */
  activity?: ConciergeActivity;
  /** Whether the badge shows. Without it the name tag takes the badge's row. */
  badge?: boolean;
  /** What the badge holds; the Concierge's mascot when not given. */
  avatar?: ReactNode;
  menu?: HeaderMenu;
}) {
  const { t } = useTranslation("chat");
  const status = statusText(activity, t);
  const busy = activity.kind !== "idle";
  const menuLabel = t("chatHeader.menu");
  const focusRing =
    "cursor-pointer outline-none outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";
  const trigger = (props: BadgeMenuProps | null) =>
    props ? { type: "button" as const, "aria-label": menuLabel, ...props } : {};
  const badgeEl = (props: BadgeMenuProps | null) => {
    const Badge = props ? "button" : "div";
    return (
      <Badge
        data-concierge-header-badge
        {...trigger(props)}
        className={cn(
          "pointer-events-auto col-start-2 row-start-1 flex size-11 items-center justify-center justify-self-center rounded-full",
          FLOATING_SURFACE,
          props && focusRing,
        )}
      >
        {avatar ?? (
          // About 60% of the badge, so the bob and the squash keep inside it.
          <RomeMascot
            alive={busy && activity.kind !== "needsYou"}
            className={cn("h-6.5 w-auto", props && "cursor-pointer")}
          />
        )}
      </Badge>
    );
  };
  const nameEl = (props: BadgeMenuProps | null) => {
    const NameTag = props ? "button" : "div";
    return (
      <NameTag
        data-concierge-header-name
        {...trigger(props)}
        className={cn(
          props && focusRing,
          badge ? "row-start-2 -mt-1" : "row-start-1",
          // Above the badge, so the tag covers the badge's edge, not the reverse.
          "pointer-events-auto relative z-10 col-start-2 flex h-5 min-w-0 max-w-full items-center justify-self-center rounded-full px-2",
          FLOATING_SURFACE,
        )}
      >
        {/* Eight CJK characters at the tag's own size, then an ellipsis. */}
        <span className="max-w-[8em] truncate text-aux font-medium text-foreground">{name}</span>
      </NameTag>
    );
  };
  return (
    <div data-concierge-header-status data-activity={activity.kind} className="contents">
      {badge ? menu ? <QuickMenu menu={menu}>{badgeEl}</QuickMenu> : badgeEl(null) : null}
      {!badge && menu ? <QuickMenu menu={menu}>{nameEl}</QuickMenu> : nameEl(null)}
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
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
};

/**
 * The badge's quick menu, to the right of the badge, each item opening its
 * tab in the side pane. Hovering the badge shows it, and a click or a tap
 * shows it too, where nothing hovers; the badge opens nothing itself. Arrow
 * Down shows it from the keyboard and moves into it. It holds no counts or
 * marks.
 */
function QuickMenu({
  menu,
  children,
}: {
  menu: HeaderMenu;
  children: (props: BadgeMenuProps) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  // Set when the keyboard opened the menu, which then takes focus.
  const fromKeyboard = useRef(false);
  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const leave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setOpen(false), LEAVE_DELAY_MS);
  };
  useEffect(() => cancelLeave, []);
  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };
  const badgeProps: BadgeMenuProps = {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onPointerEnter: (event) => {
      if (event.pointerType !== "mouse") return;
      cancelLeave();
      setOpen(true);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse") leave();
    },
    // A hover has shown it already; a click keeps it, and a tap toggles it.
    onClick: (event) => {
      event.preventDefault();
      cancelLeave();
      setOpen((was) =>
        (event.nativeEvent as globalThis.PointerEvent).pointerType === "mouse" ? true : !was,
      );
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        fromKeyboard.current = true;
        setOpen(true);
      }
    },
  };
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor asChild>{children(badgeProps)}</PopoverAnchor>
      <PopoverContent
        role="menu"
        aria-label={t("chatHeader.menu")}
        side="right"
        align="start"
        sideOffset={8}
        // Hover or a tap leaves focus where it was; Arrow Down moves it to
        // the first item.
        onOpenAutoFocus={(event) => {
          if (!fromKeyboard.current) event.preventDefault();
          fromKeyboard.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const all = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
          const at = all.indexOf(document.activeElement as HTMLElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          all[(at + step + all.length) % all.length]?.focus();
        }}
        onPointerEnter={cancelLeave}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") leave();
        }}
        className="w-auto max-w-64 min-w-40 gap-1 p-1"
      >
        {menu.items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            data-concierge-menu-item={item.key}
            onClick={() => choose(item.run)}
            className="flex h-[var(--control-h-md)] w-full min-w-0 cursor-pointer items-center gap-2 rounded-8 px-2 text-left text-ui text-foreground outline-none outline-1 -outline-offset-1 outline-transparent hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
          >
            {item.icon}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        ))}
        {menu.caption ? (
          <div
            data-concierge-menu-caption
            className="flex min-w-0 items-center gap-2 border-t border-border-subtle px-2 pt-2 pb-1 text-aux text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
          >
            {menu.caption}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
