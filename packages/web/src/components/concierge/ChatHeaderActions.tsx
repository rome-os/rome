import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { ListChecks, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { FLOATING_SURFACE } from "./ConciergeHeaderStatus";

/** One entry of the header's ⋯ menu. */
export interface HeaderMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  /** Drawn in the destructive colour: Delete. */
  destructive?: boolean;
  run: () => void;
}

/**
 * The header's ⋯ menu: groups of entries with a rule between them (what opens
 * in the side pane, then what is done to the chat), and a quiet line at its
 * foot, such as the model that last answered. An empty group is left out.
 */
export interface HeaderMenu {
  sections: HeaderMenuItem[][];
  caption?: ReactNode;
}

/**
 * The right of a chat's header: one capsule holding Tasks and ⋯. Tasks opens
 * the chat's task list in the side pane, with a dot while a task needs the
 * guardian; a chat with no task list has ⋯ alone, a round button. Floating,
 * the capsule takes the header's translucent surface; in the Mac app's title
 * bar the buttons are any window's.
 */
export function ChatHeaderActions({
  tasks,
  menu,
  floating,
}: {
  tasks?: { needsYou: boolean; open: () => void };
  menu: HeaderMenu;
  floating: boolean;
}) {
  const { t } = useTranslation("chat");
  const size = floating ? "md" : "sm";
  const button = floating
    ? "rounded-full text-foreground"
    : "text-muted-foreground hover:text-foreground";
  return (
    <div
      data-chat-header-actions
      className={cn("flex items-center", floating && cn("rounded-full", FLOATING_SURFACE))}
    >
      {tasks ? (
        <>
          <IconButton
            size={size}
            label={t("concierge.menu.tasks")}
            data-chat-header-tasks
            className={button}
            onClick={tasks.open}
            icon={
              <span className="relative">
                <ListChecks />
                {tasks.needsYou ? (
                  <span
                    role="img"
                    aria-label={t("concierge.menu.needsYouDot")}
                    data-chat-header-tasks-dot
                    className="absolute -right-1 -top-1 size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </span>
            }
          />
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        </>
      ) : null}
      <MoreMenu menu={menu}>
        {(props) => (
          <IconButton
            size={size}
            label={t("navbar.more")}
            icon={<MoreHorizontal />}
            className={button}
            {...props}
          />
        )}
      </MoreMenu>
    </div>
  );
}

// How long the pointer may be off both the button and the menu before it
// closes, so it can cross the gap between them.
const LEAVE_DELAY_MS = 150;

type MoreButtonProps = {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
};

/**
 * The ⋯ menu, under its button. Hovering the button shows it, and a click or
 * a tap shows it too, where nothing hovers; Arrow Down, Enter or Space shows
 * it from the keyboard and moves into it, and Escape or a click outside closes
 * it.
 */
function MoreMenu({
  menu,
  children,
}: {
  menu: HeaderMenu;
  children: (props: MoreButtonProps) => ReactNode;
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
  const buttonProps: MoreButtonProps = {
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
    // A keyboard's Enter or Space arrives as a click with no pointer.
    onClick: (event) => {
      event.preventDefault();
      cancelLeave();
      const pointer = (event.nativeEvent as globalThis.PointerEvent).pointerType;
      if (!pointer) fromKeyboard.current = true;
      setOpen((was) => (pointer === "mouse" ? true : !was));
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        fromKeyboard.current = true;
        setOpen(true);
      }
    },
  };
  const sections = menu.sections.filter((section) => section.length > 0);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      {/* The button itself is the anchor: it forwards the ref the menu is placed by. */}
      <PopoverAnchor asChild>{children(buttonProps)}</PopoverAnchor>
      <PopoverContent
        role="menu"
        aria-label={t("chatHeader.menu")}
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        // Hover or a tap leaves focus where it was; the keyboard moves it to
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
        className="w-auto max-w-64 min-w-44 gap-0 p-1"
      >
        {sections.map((section, index) => (
          <div
            key={section[0]!.key}
            role="group"
            data-chat-header-menu-section
            className={cn(
              "flex flex-col gap-1",
              index > 0 && "mt-1 border-t border-border-subtle pt-1",
            )}
          >
            {section.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                data-chat-header-menu-item={item.key}
                onClick={() => choose(item.run)}
                className={cn(
                  "flex h-[var(--control-h-md)] w-full min-w-0 cursor-pointer items-center gap-2 rounded-8 px-2 text-left text-ui outline-none outline-1 -outline-offset-1 outline-transparent hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
                  item.destructive
                    ? "text-destructive [&_svg]:text-destructive"
                    : "text-foreground [&_svg]:text-muted-foreground",
                )}
              >
                {item.icon}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
        {menu.caption ? (
          <div
            data-chat-header-menu-caption
            className={cn(
              "flex min-w-0 items-center gap-2 px-2 pt-2 pb-1 text-aux text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
              sections.length > 0 && "mt-1 border-t border-border-subtle",
            )}
          >
            {menu.caption}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
