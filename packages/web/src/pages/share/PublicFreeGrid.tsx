import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { FolderKanban, LayoutGrid, MessageSquare } from "lucide-react";
import { PublicChat } from "@/components/chat/PublicChat";
import { AppWidget } from "@/pages/free/AppWidget";
import type { WidgetPlacement } from "@/pages/free/use-free-cells";
import type { ChatMessage } from "@/lib/chat-types";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { PublicProjectsWidget } from "./PublicProjectsWidget";

// Mirror of FreeGrid's chat column width so the public page matches /chat.
const CHAT_COLUMN_WIDTH = "clamp(420px, 34vw, 680px)";

interface PublicFreeGridProps {
  placements: WidgetPlacement[];
  token: string;
  chat: { messages: ChatMessage[]; mainSessionId: string; traces: Record<string, TraceSnapshot> };
}

function PublicWidgetContent({ widget, token }: { widget: WidgetPlacement; token: string }) {
  switch (widget.type) {
    case "app":
      return widget.targetId ? (
        <AppWidget
          appId={widget.targetId}
          route={widget.route}
          params={widget.params}
          dragging={false}
        />
      ) : null;
    case "projects":
      return <PublicProjectsWidget token={token} initialSelectedPath={widget.selectedPath} />;
    // `desktop` (browser/noVNC) is stripped at share time and never reaches here.
    default:
      return null;
  }
}

function widgetLabel(widget: WidgetPlacement, t: (k: string) => string): string {
  if (widget.type === "projects") return t("nav.projects");
  if (widget.type === "app") return widget.targetId ?? t("nav.apps");
  return "";
}

// Icon set mirrors FreeGrid's WidgetIcon. The share page is unauthenticated, so
// the installed-app catalog (real icon + display name) is out of reach — app
// tiles fall back to the generic grid glyph.
function PublicWidgetIcon({ widget, className }: { widget: WidgetPlacement; className?: string }) {
  if (widget.type === "projects") return <FolderKanban className={className} />;
  if (widget.type === "app") return <LayoutGrid className={className} />;
  return null;
}

// Read-only twin of FreeGrid: the frozen chat as the base column, live app +
// read-only projects tiles in the right strip. No dnd, no add/close, no
// composer — the layout is fixed by the snapshot.
export function PublicFreeGrid({ placements, token, chat }: PublicFreeGridProps) {
  const { t } = useTranslation("common");
  const sorted = useMemo(
    () => [...placements].filter((p) => p.type !== "desktop").sort((a, b) => a.order - b.order),
    [placements],
  );
  const hasApps = sorted.length > 0;
  // "chat" or a placement id — mobile tab switcher.
  const [mobileTab, setMobileTab] = useState<"chat" | string>("chat");

  return (
    <div className={`relative min-h-dvh ${hasApps ? "" : "pt-safe"}`}>
      {/* Mobile tab pill */}
      {hasApps && (
        <div className="sticky top-0 z-30 flex h-[var(--rome-mobile-header-height)] items-center gap-1 overflow-x-auto border-b border-border bg-background/90 px-2 pt-safe backdrop-blur-md md:hidden">
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
          {sorted.map((widget) => (
            <button
              key={widget.id}
              type="button"
              onClick={() => setMobileTab(widget.id)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-aux transition ${
                mobileTab === widget.id
                  ? "bg-surface-hover text-foreground"
                  : "text-subtle-foreground hover:text-foreground"
              }`}
            >
              <PublicWidgetIcon widget={widget} className="h-3.5 w-3.5" />
              <span className="truncate">{widgetLabel(widget, t)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Chat column */}
      <div
        style={{ "--rome-chat-col": CHAT_COLUMN_WIDTH } as CSSProperties}
        className={`relative ${
          hasApps
            ? "min-h-[var(--rome-mobile-content-height)]"
            : "min-h-[calc(100dvh-var(--rome-safe-area-top))]"
        } md:min-h-dvh ${
          hasApps ? "md:w-[var(--rome-chat-col)]" : "w-full"
        } ${hasApps && mobileTab !== "chat" ? "max-md:hidden" : ""}`}
      >
        <PublicChat
          messages={chat.messages}
          mainSessionId={chat.mainSessionId}
          traces={chat.traces}
          hasApps={hasApps}
        />
      </div>

      {/* Apps strip — flush against the chat column on desktop (no sidebar here,
          so the left offset is just the chat width). */}
      {hasApps && (
        <aside
          style={{ "--rome-apps-left": CHAT_COLUMN_WIDTH } as CSSProperties}
          className={`fixed inset-0 z-20 bg-surface md:left-[var(--rome-apps-left)] md:h-dvh max-md:top-[var(--rome-mobile-header-height)] ${
            mobileTab === "chat" ? "max-md:hidden" : ""
          }`}
        >
          <div className="flex h-full gap-2 overflow-x-auto overscroll-x-contain p-2 max-md:flex-col max-md:overflow-x-visible max-md:overflow-y-auto">
            {sorted.map((widget) => (
              <div
                key={widget.id}
                className={`relative flex h-full min-w-0 flex-1 flex-shrink-0 flex-col overflow-hidden rounded-12 border border-border bg-surface pb-safe md:pb-0 ${
                  widget.id === mobileTab ? "" : "max-md:hidden"
                }`}
                style={{ minWidth: 320 }}
              >
                <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-1 max-md:hidden">
                  <PublicWidgetIcon
                    widget={widget}
                    className="h-3.5 w-3.5 text-subtle-foreground"
                  />
                  <span className="flex-1 truncate text-aux text-subtle-foreground">
                    {widgetLabel(widget, t)}
                  </span>
                </div>
                <div className="relative min-h-0 flex-1 overflow-auto overscroll-y-contain">
                  <PublicWidgetContent widget={widget} token={token} />
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
