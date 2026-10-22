import { useTranslation } from "react-i18next";
import { QuickEntryGrid } from "@/components/chat/QuickEntryGrid";
import { RomeLogo } from "@/components/logo";
import { cn } from "@/lib/utils";
import type { ResolvedRomeNewsItem } from "@rome-os/rome-web-components/news-item/schema";

export interface ChatEmptyStateProps {
  guardianName: string;
  quickEntries: ResolvedRomeNewsItem[];
  onActivateQuickEntry: (entry: ResolvedRomeNewsItem) => void;
  /**
   * From `md` up, sit at the bottom of the area so the greeting hugs the
   * composer, which Chat centers with it (see `centerDraftComposer`).
   */
  hugComposer?: boolean;
}

/**
 * The draft chat's home content. It brings no scroller or composer of its own:
 * Chat renders it inside its transcript scroller, above the composer floor.
 */
export function ChatEmptyState({
  guardianName,
  quickEntries,
  onActivateQuickEntry,
  hugComposer = false,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");
  const firstName = guardianName.trim().split(/\s+/)[0];
  const greeting = firstName
    ? t("empty.greeting", { name: firstName })
    : t("empty.greetingFallback");

  return (
    <main
      className={cn(
        "mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-12",
        hugComposer && "md:flex-auto md:justify-end md:pb-8 md:pt-0",
      )}
    >
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

      {quickEntries.length > 0 ? (
        <section className="rome-empty-rise mt-12" style={{ animationDelay: "320ms" }}>
          <h2 className="mb-3 text-aux text-foreground">{t("empty.romeNews")}</h2>
          <QuickEntryGrid entries={quickEntries} onActivate={onActivateQuickEntry} />
        </section>
      ) : null}
    </main>
  );
}
