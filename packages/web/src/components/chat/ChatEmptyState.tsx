import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Pin, X } from "lucide-react";
import { HorizontalScrollRail } from "@/components/chat/HorizontalScrollRail";
import { QuickEntryGrid } from "@/components/chat/QuickEntryGrid";
import { RomeLogo } from "@/components/logo";
import type { ResolvedRomeNewsItem } from "@rome-os/rome-web-components/news-item/schema";
import { usePresentationMode } from "@/lib/presentation-mode";
import { cn } from "@/lib/utils";

export interface PinnedChatSummary {
  id: string;
  name: string;
  projectName: string;
}

export interface ChatEmptyStateProps {
  guardianName: string;
  pinnedChats: PinnedChatSummary[];
  quickEntries: ResolvedRomeNewsItem[];
  onOpenPinnedChat: (id: string) => void;
  onUnpinChat: (id: string) => void;
  onActivateQuickEntry: (entry: ResolvedRomeNewsItem) => void;
  composer: ReactNode;
}

export function ChatEmptyState({
  guardianName,
  pinnedChats,
  quickEntries,
  onOpenPinnedChat,
  onUnpinChat,
  onActivateQuickEntry,
  composer,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");
  const presentationMode = usePresentationMode();
  const firstName = guardianName.trim().split(/\s+/)[0];
  const greeting = firstName
    ? t("empty.greeting", { name: firstName })
    : t("empty.greetingFallback");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-12 pt-12 md:pt-16">
        <header className="max-w-3xl">
          <RomeLogo
            className="rome-empty-rise h-9 w-9 text-foreground"
            style={{ animationDelay: "80ms" }}
            aria-hidden
          />
          <p
            className="rome-empty-rise mt-5 text-display text-muted-foreground"
            style={{ animationDelay: "140ms", fontOpticalSizing: "auto" }}
          >
            {greeting}
          </p>
          <h1
            className="rome-empty-rise mt-1 font-serif text-[2.65rem] font-normal leading-[1.05] tracking-[-0.025em] text-foreground md:text-[3.35rem]"
            style={{ animationDelay: "200ms", fontOpticalSizing: "auto" }}
          >
            {t("empty.headline")}
          </h1>
        </header>

        {pinnedChats.length > 0 ? (
          <section
            className="rome-empty-rise mt-12"
            style={{ animationDelay: "240ms" }}
            aria-label={t("empty.pinnedChats")}
          >
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="size-4 text-subtle-foreground" aria-hidden />
              <h2 className="text-aux text-foreground">{t("empty.pinnedChats")}</h2>
              <span className="text-aux tabular-nums text-subtle-foreground">
                {pinnedChats.length}
              </span>
            </div>
            <HorizontalScrollRail id="pinned-chats">
              {pinnedChats.map((chat) => (
                <div
                  key={chat.id}
                  className="group flex w-[17rem] flex-none items-center gap-1 rounded-12 border border-border bg-surface/70 p-1 transition hover:border-border-strong hover:bg-surface"
                  role="listitem"
                >
                  <button
                    type="button"
                    onClick={() => onOpenPinnedChat(chat.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-8 px-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pin className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-foreground">{chat.name}</span>
                      {chat.projectName ? (
                        <span className="mt-1 block truncate text-aux text-subtle-foreground">
                          {chat.projectName}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onUnpinChat(chat.id)}
                    className="rounded-8 p-2 text-subtle-foreground transition hover:bg-surface-hover hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("empty.unpinChat", { name: chat.name })}
                    title={t("empty.unpin")}
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </HorizontalScrollRail>
          </section>
        ) : null}

        {quickEntries.length > 0 ? (
          <section className="rome-empty-rise mt-12" style={{ animationDelay: "320ms" }}>
            <h2 className="mb-3 text-aux text-foreground">{t("empty.romeNews")}</h2>
            <QuickEntryGrid entries={quickEntries} onActivate={onActivateQuickEntry} />
          </section>
        ) : null}
      </main>

      {/* Match the live chat's translucent sticky composer floor. */}
      <div
        className={cn(
          "pointer-events-none sticky bottom-0 z-10 px-3 md:px-6",
          // Presentation mode gives the bottom gap 5x its normal size so a
          // recording framed on the empty state keeps the composer clear of
          // the capture's lower edge.
          presentationMode
            ? "pb-[calc(var(--rome-safe-area-bottom)+5rem)] md:pb-[calc(var(--rome-safe-area-bottom)+7.5rem)]"
            : "pb-[calc(var(--rome-safe-area-bottom)+1rem)] md:pb-[calc(var(--rome-safe-area-bottom)+1.5rem)]",
        )}
      >
        <div
          className="rome-empty-rise pointer-events-auto mx-auto max-w-5xl"
          style={{ animationDelay: "380ms" }}
        >
          {composer}
        </div>
      </div>
    </div>
  );
}
