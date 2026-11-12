import type { TFunction } from "i18next";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/** An answer short enough to repeat on a folded card. */
const SHORT_ANSWER = 24;

/** How a question card's answer reads folded: the answer when short, or that it was dismissed. */
export function answerOutcome(t: TFunction<"chat">, output: Record<string, unknown>): string {
  if (output.dismissed === true) return t("concierge.ask.dismissed");
  const values = (Array.isArray(output.answers) ? output.answers : [])
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { value?: unknown }).value : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const text = values.join(", ");
  return text && text.length <= SHORT_ANSWER
    ? t("concierge.ask.answeredWith", { answer: text })
    : t("concierge.ask.answered");
}

/**
 * How a decided approval reads folded: approved, rejected by its owner, or
 * turned down by Rome as its task's wait ran out or as its task was stopped.
 */
export function approvalOutcome(
  t: TFunction<"chat">,
  status: string,
  resolvedBy: string | null | undefined,
): string {
  if (resolvedBy === "rome:task-ended") return t("concierge.ask.turnedDown");
  if (resolvedBy === "rome:task-stopped") return t("concierge.ask.turnedDownStopped");
  if (status === "rejected") return t("concierge.ask.rejected");
  if (status === "failed") return t("approvals.status.failed");
  return t("concierge.ask.approved");
}

const CARD =
  "flex w-full min-w-0 flex-col rounded-12 border border-border bg-surface px-4 py-2 text-left";

/**
 * A question or approval card that no longer waits, folded to two lines: what
 * it asked, muted on one line, then how it ended. With `full`, a click opens
 * the original card below, read-only; `onOpen` instead hands the click on, as
 * an expired question does to open its form.
 */
export function SettledCard({
  title,
  outcome,
  full,
  onOpen,
  chevron = false,
}: {
  title: string | null;
  outcome: string;
  full?: ReactNode;
  onOpen?: () => void;
  /** Whether the outcome reads as a way on, as "answer to continue" does. */
  chevron?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = (
    <>
      {title ? (
        <span className="w-full truncate text-aux text-muted-foreground">{title}</span>
      ) : null}
      <span className="flex items-center gap-1 text-ui text-foreground">
        {outcome}
        {chevron ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : null}
      </span>
    </>
  );
  if (!full && !onOpen) {
    return (
      <div data-chat-settled-card className={`${CARD} max-w-md`}>
        {lines}
      </div>
    );
  }
  return (
    <div data-chat-settled-card className="flex w-full min-w-0 max-w-md flex-col gap-2">
      <button
        type="button"
        aria-expanded={onOpen ? false : open}
        onClick={() => (onOpen ? onOpen() : setOpen((current) => !current))}
        className={`${CARD} outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none`}
      >
        {lines}
      </button>
      {open ? full : null}
    </div>
  );
}
