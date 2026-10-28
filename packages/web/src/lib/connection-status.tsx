/**
 * Shared status presentation for the unified Connections surface.
 *
 * `StatusIndicator` is a dot (semantic color token) + text — NOT a filled
 * `Badge`. It is the single source of the status vocabulary so the list and the
 * detail-page header render identically.
 *
 * Four labels, each meaning something different to the guardian
 * ("Disconnected" is banned vocabulary). Working and Broken are the
 * connection's own states (docs/domains/connections.md):
 *   Working       → the platform accepts Rome's access.
 *   Broken        → the platform stopped accepting it. The account and its
 *                   agent stay until the guardian gives access again.
 *   Not connected → nothing gives Rome access yet. Open to connect.
 *   Unavailable   → it doesn't work and you *can't* fix it (host misconfig);
 *                   carries the reason as a tooltip.
 *
 * A working connection whose transport is temporarily impaired keeps the
 * Working label with an amber dot and the reason as a tooltip, since the
 * platform still accepts its grant and recovery may happen automatically.
 *
 * Mapping over the card's slot states:
 *   any slot broken                        → amber dot, "Broken"
 *   transient runtime degradation          → amber dot, "Working" (reason tooltip)
 *   any slot working                       → green dot, "Working"
 *   none connected + connect unavailable   → muted dot, "Unavailable" (reason tooltip)
 *   everything else                        → muted dot, "Not connected"
 */

import { cn } from "@/lib/utils";
import type { ConnectionCard } from "@/lib/connection-cards";
import { AlertTriangle } from "lucide-react";

type DotTone = "success" | "attention" | "muted";

export interface ConnectionStatus {
  label: string;
  tone: DotTone;
  /** Optional detail surfaced as a hover tooltip. */
  title?: string;
}

/** Maps a card's slot states onto the dot+text status vocabulary. */
export function connectionStatus(card: ConnectionCard): ConnectionStatus {
  const states = new Set(card.slots.map((slot) => slot.state));
  // A broken connection surfaces even when a sibling slot still works, since
  // it needs the guardian's attention more than "1 of 2 works".
  if (states.has("broken")) {
    return {
      label: "Broken",
      tone: "attention",
      title: "The platform stopped accepting Rome's access. Give access again.",
    };
  }
  if (card.degradation) {
    const retry = card.degradation.retryAt
      ? ` Automatic retry at ${card.degradation.retryAt}.`
      : "";
    return {
      label: "Working",
      tone: "attention",
      title: `${card.degradation.reason}${retry}`,
    };
  }
  if (states.has("working")) {
    return { label: "Working", tone: "success" };
  }
  // A service the host can't offer (misconfig) is the only "you can't fix this"
  // case; everything else is a fixable "Not connected" whose specific next step
  // lives in the detail view.
  if (card.connect && !card.connect.available) {
    return {
      label: "Unavailable",
      tone: "muted",
      title: card.connect.unavailableReason ?? undefined,
    };
  }
  return { label: "Not connected", tone: "muted" };
}

const DOT_TONE: Record<DotTone, string> = {
  success: "bg-success",
  attention: "bg-warning",
  // A hollow muted dot reads as neutral without competing with the live tone.
  muted: "border border-muted-foreground/40",
};

/**
 * A status dot + label. Pass a `ConnectionCard` (resolves the vocabulary via
 * `connectionStatus`) or a pre-resolved `ConnectionStatus`.
 */
export function StatusIndicator({
  card,
  status,
  className,
}: {
  card?: ConnectionCard;
  status?: ConnectionStatus;
  className?: string;
}) {
  const resolved = status ?? (card ? connectionStatus(card) : undefined);
  if (!resolved) return null;

  return (
    <span
      className={cn("inline-flex items-center gap-2 text-ui text-muted-foreground", className)}
      title={resolved.title}
    >
      <span
        className={cn("inline-block size-2 shrink-0 rounded-full", DOT_TONE[resolved.tone])}
        aria-hidden
      />
      {resolved.tone === "attention" ? (
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      ) : null}
      {resolved.label}
    </span>
  );
}
