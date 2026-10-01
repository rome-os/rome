// PROTOTYPE — variant C's bottom tab bar. Four destinations a guardian opens
// most from a phone, plus "More", which opens the existing slide-over with the
// rest (projects, memory, people, sessions, settings, recent chats).
import { Activity, CalendarClock, LayoutGrid, Menu, MessageSquare } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/chat", label: "Chat", Icon: MessageSquare },
  { to: "/apps", label: "Apps", Icon: LayoutGrid },
  { to: "/activity", label: "Activity", Icon: Activity },
  { to: "/routines", label: "Routines", Icon: CalendarClock },
];

export function PhoneTabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const { pathname } = useLocation();
  const item =
    "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] leading-[0.875rem] font-medium";
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-background/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      style={{ height: "calc(var(--proto-tabbar-h) + env(safe-area-inset-bottom))" }}
    >
      {TABS.map(({ to, label, Icon }) => {
        const active = pathname === to || pathname.startsWith(`${to}/`);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(item, active ? "text-primary" : "text-muted-foreground")}
          >
            <Icon className="size-6" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
            {label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        aria-expanded={moreOpen}
        className={cn(item, moreOpen ? "text-primary" : "text-muted-foreground")}
      >
        <Menu className="size-6" strokeWidth={1.8} aria-hidden />
        More
      </button>
    </nav>
  );
}
