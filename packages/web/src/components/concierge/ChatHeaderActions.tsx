import {
  Fragment,
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
import { dropdownMenuItemVariants } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
            // The dot is drawn only; the name says it too.
            label={
              tasks.needsYou
                ? `${t("concierge.menu.tasks")}, ${t("concierge.menu.needsYouDot")}`
                : t("concierge.menu.tasks")
            }
            data-chat-header-tasks
            className={button}
            onClick={tasks.open}
            icon={
              <span className="relative">
                <ListChecks />
                {tasks.needsYou ? (
                  <span
                    aria-hidden
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
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
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
  // The pointer that pressed the button, read by the click that follows.
  const pressedWith = useRef<string | null>(null);
  // How the open menu was opened, and whether focus went into it: a menu
  // only hovered open gives focus back to nothing when it closes, so the
  // composer keeps it.
  const openedBy = useRef<"hover" | "press">("press");
  const focusedInside = useRef(false);
  const show = (by: "hover" | "press") => {
    if (!open || by === "press") openedBy.current = by;
    if (!open) focusedInside.current = false;
    setOpen(true);
  };
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
      show("hover");
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse") leave();
    },
    onPointerDown: (event) => {
      pressedWith.current = event.pointerType;
    },
    // A hover has shown it already, so a mouse's click keeps it; a tap
    // toggles it. A keyboard's Enter or Space arrives as a click with no
    // press count (`detail` 0), and moves focus into the menu.
    onClick: (event) => {
      event.preventDefault();
      cancelLeave();
      const keyboard = event.detail === 0;
      const mouse = !keyboard && pressedWith.current === "mouse";
      pressedWith.current = null;
      if (keyboard) fromKeyboard.current = true;
      openedBy.current = "press";
      setOpen((was) => (mouse ? true : !was));
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        fromKeyboard.current = true;
        show("press");
      }
    },
  };
  const sections = menu.sections.filter((section) => section.length > 0);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      {/* The button is the menu's trigger, so Escape returns focus to it. Its
          click handler prevents the trigger's own toggle: the open state is ours. */}
      <PopoverTrigger asChild>{children(buttonProps)}</PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label={t("chatHeader.menu")}
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        // Hover or a tap leaves focus where it was; the keyboard moves it to
        // the first item.
        onFocusCapture={() => {
          focusedInside.current = true;
        }}
        // Focus goes back to ⋯ only for a menu opened by a click, a tap or
        // the keyboard, or one focus went into; a hovered one leaves it be.
        onCloseAutoFocus={(event) => {
          if (openedBy.current === "hover" && !focusedInside.current) event.preventDefault();
        }}
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
          <Fragment key={section[0]!.key}>
            {index > 0 ? <MenuDivider /> : null}
            <div role="group" data-chat-header-menu-section className="flex flex-col gap-0">
              {section.map((item) => (
                // The shared menu's item, as a plain button: this menu opens
                // on hover, which a Radix menu does not.
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  data-chat-header-menu-item={item.key}
                  data-variant={item.destructive ? "destructive" : undefined}
                  onClick={() => choose(item.run)}
                  className={cn(
                    dropdownMenuItemVariants(),
                    "w-full min-w-0 cursor-pointer text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring/50 data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:hover:text-destructive",
                    !item.destructive && "[&_svg]:text-muted-foreground",
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ))}
        {menu.caption ? (
          <>
            {sections.length > 0 ? <MenuDivider /> : null}
            <div
              data-chat-header-menu-caption
              className="flex min-w-0 items-center gap-2 px-2 py-1 text-aux text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              {menu.caption}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A rule between the menu's parts: the shared menu separator, a line with a
 * little space above and below. In dark the stronger border, or it is lost
 * on the dark popover.
 */
function MenuDivider() {
  return (
    <div
      role="separator"
      data-chat-header-menu-divider
      className="-mx-1 my-1 h-px bg-border dark:bg-border-strong"
    />
  );
}
