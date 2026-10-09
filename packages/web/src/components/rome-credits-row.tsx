import { useTranslation } from "react-i18next";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";

import { RomeLogo } from "@/components/logo";

type RomeCreditsState = "inUse" | "ready" | "standby" | "usedUp" | "usedUpWithClaude" | "paused";

const MICROS_PER_DOLLAR = 1_000_000;

const STATE_TONE: Record<RomeCreditsState, { dot: string; text: string; bar: string }> = {
  inUse: { dot: "bg-success", text: "text-success-fg", bar: "bg-success" },
  ready: { dot: "bg-muted-foreground/50", text: "text-muted-foreground", bar: "bg-success" },
  standby: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    bar: "bg-border-strong",
  },
  usedUp: { dot: "bg-destructive", text: "text-destructive-fg", bar: "bg-destructive" },
  usedUpWithClaude: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    bar: "bg-border-strong",
  },
  paused: { dot: "bg-warning", text: "text-warning-fg", bar: "bg-border-strong" },
};

function microsToDollars(micros: string): number {
  return Number(BigInt(micros)) / MICROS_PER_DOLLAR;
}

/** Formats a microdollar amount as US dollars, never below zero: an overrun
 *  reads as nothing left rather than a negative balance. */
export function formatCreditDollars(micros: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
    Math.max(0, microsToDollars(micros)),
  );
}

/** Whether the credits can still pay for a turn. Holds for running requests
 *  count against it, so `availableMicros` decides rather than the balance. */
export function hasUsableRomeCredits(credits: RomeCreditsView | null | undefined): boolean {
  return credits != null && credits.enabled && BigInt(credits.availableMicros) > 0n;
}

/** Credits pay for Codex only while ChatGPT is disconnected, so a connected
 *  ChatGPT login leaves them on standby whatever is left. A tier prefers a
 *  connected Claude login, so with Claude connected they pay only for a chosen
 *  ChatGPT model, and running out leaves chats working. */
export function getRomeCreditsState(
  credits: RomeCreditsView,
  { chatgptConnected, claudeConnected }: { chatgptConnected: boolean; claudeConnected: boolean },
): RomeCreditsState {
  if (!credits.enabled) return "paused";
  if (chatgptConnected) return "standby";
  if (BigInt(credits.availableMicros) <= 0n) {
    return claudeConnected ? "usedUpWithClaude" : "usedUp";
  }
  return claudeConnected ? "ready" : "inUse";
}

export function RomeCreditsRow({
  credits,
  chatgptConnected,
  claudeConnected,
}: {
  credits: RomeCreditsView;
  chatgptConnected: boolean;
  claudeConnected: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const state = getRomeCreditsState(credits, { chatgptConnected, claudeConnected });
  const tone = STATE_TONE[state];
  const granted = microsToDollars(credits.grantedMicros);
  const remaining = Math.max(0, microsToDollars(credits.availableMicros));
  const remainingPercent = granted > 0 ? Math.min(100, (remaining / granted) * 100) : 0;

  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-8 bg-primary text-primary-foreground [--background:var(--primary)]"
          aria-hidden
        >
          <RomeLogo className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-ui text-foreground">{t("aiTools.romeCredits.name")}</p>
            <span className={`inline-flex items-center gap-1 text-aux ${tone.text}`}>
              <span className={`size-1.5 rounded-full ${tone.dot}`} />
              {t(`aiTools.romeCredits.status.${state}` as const)}
            </span>
          </div>
          <p className="text-aux text-muted-foreground">
            {t(`aiTools.romeCredits.detail.${state}` as const)}
          </p>
        </div>
        <div className="ml-auto shrink-0 text-right">
          <span className={`text-title ${state === "usedUp" ? tone.text : "text-foreground"}`}>
            {formatCreditDollars(credits.availableMicros, i18n.language)}
          </span>
          <p className="text-aux text-muted-foreground">
            {t("aiTools.romeCredits.ofGranted", {
              amount: formatCreditDollars(credits.grantedMicros, i18n.language),
            })}
          </p>
        </div>
      </div>
      <div
        className="mt-2 mb-1 h-1.5 rounded-full bg-border-subtle"
        role="meter"
        aria-label={t("aiTools.romeCredits.meterLabel")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remainingPercent)}
      >
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${remainingPercent}%` }}
        />
      </div>
    </div>
  );
}
