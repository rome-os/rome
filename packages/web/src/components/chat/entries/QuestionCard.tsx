import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { answerOutcome, SettledCard } from "./SettledCard";

// Core built-in rendering of the agent's `ask_question` tool. The tool parks the
// turn with a `pending_interaction` whose render is `{ kind: "inline",
// componentId: "question-card", builtin: true, props: { questions } }`; this
// component collects the answers and posts them back through the same
// `interaction_result` path an app component would use (onSubmit), which resumes
// the agent on the next turn. No app is mounted — this is shipped with the host.

interface Question {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
  defaults?: string[];
  defaultText?: string;
  optionDescriptions?: Record<string, string>;
  /** single/multi only: also show a free-text box beneath the options. */
  freeText?: boolean;
  /** Question may be left blank without blocking submit. */
  optional?: boolean;
}

interface Answer {
  questionId: string;
  value: string;
  /** Lossless parts when a multi answer contains the display separator. */
  values?: string[];
}

/** How a multi-choice answer joins its selected options into one string value. */
const MULTI_SEP = ", ";

/**
 * An option can wrap, so it takes the `sm` step as a floor rather than as a
 * fixed height. One line sits under that floor, so the box is the step exactly
 * and the Button's own `items-center` centres the label; two lines outgrow it
 * and the box follows the text. Plain options have no vertical padding — any
 * step big enough to see would push a single line past the floor and off the
 * scale, and the line box's half-leading already separates a wrapped label from
 * the border.
 */
const OPTION =
  "h-auto min-h-[var(--control-h-sm)] min-w-0 max-w-full whitespace-normal wrap-anywhere";

/** Split a stored multi answer back into its parts (used to rehydrate a resolved card). */
function splitMulti(value: string): string[] {
  return value
    .split(MULTI_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An option's own description, ignoring keys inherited from `Object.prototype`
 * (an option may be labeled `__proto__` or `constructor`). */
function descriptionOf(q: Question, option: string): string | undefined {
  const descriptions = q.optionDescriptions;
  return descriptions && Object.hasOwn(descriptions, option) ? descriptions[option] : undefined;
}

function parseQuestions(props: Record<string, unknown> | undefined): Question[] {
  const raw = props?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.question !== "string") return [];
    const type = o.type === "text" ? "text" : o.type === "multi" ? "multi" : "single";
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === "string")
      : undefined;
    const freeText = (type === "single" || type === "multi") && o.freeText === true;
    const optional = o.optional === true;
    const defaults = Array.isArray(o.defaults)
      ? o.defaults.filter((x): x is string => typeof x === "string" && (options ?? []).includes(x))
      : undefined;
    const defaultText = typeof o.defaultText === "string" ? o.defaultText : undefined;
    const optionDescriptions =
      o.optionDescriptions && typeof o.optionDescriptions === "object"
        ? Object.fromEntries(
            Object.entries(o.optionDescriptions).filter(
              ([label, description]) => options?.includes(label) && typeof description === "string",
            ),
          )
        : undefined;
    return [
      {
        id: o.id,
        question: o.question,
        type,
        options,
        freeText,
        optional,
        defaults,
        defaultText,
        optionDescriptions,
      },
    ];
  });
}

function answersFromResult(result: Record<string, unknown> | undefined): Answer[] {
  const raw = result?.answers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    if (typeof o.questionId !== "string" || typeof o.value !== "string") return [];
    const values =
      Array.isArray(o.values) && o.values.every((v) => typeof v === "string")
        ? (o.values as string[])
        : undefined;
    return [{ questionId: o.questionId, value: o.value, values }];
  });
}

export interface QuestionCardProps {
  toolUseId: string;
  props?: Record<string, unknown>;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
  onDismiss: (toolUseId: string) => void;
  /** Shown at the top inside the card, such as the task it is for. */
  header?: ReactNode;
  /**
   * How it shows once answered or dismissed: folded to what it asked and how
   * it ended, opening to the whole card read-only (the default), or whole.
   */
  settled?: "fold" | "full";
}

export function QuestionCard({ settled = "fold", ...card }: QuestionCardProps) {
  const { t } = useTranslation("chat");
  if (settled === "fold" && card.result !== undefined) {
    const title = parseQuestions(card.props)
      .map((q) => q.question)
      .join(" · ");
    return (
      <SettledCard
        title={title || null}
        outcome={answerOutcome(t, card.result)}
        full={<WholeQuestionCard {...card} />}
      />
    );
  }
  return <WholeQuestionCard {...card} />;
}

function WholeQuestionCard({
  toolUseId,
  props,
  result,
  onSubmit,
  onDismiss,
  header,
}: Omit<QuestionCardProps, "settled">) {
  const { t } = useTranslation("chat");
  const questions = parseQuestions(props);
  const resolved = result !== undefined;
  // Dismissed (the guardian skipped the card — tapped Dismiss, or answered in
  // chat, which auto-dismisses it) vs answered through the card.
  const dismissed = resolved && (result as { dismissed?: unknown }).dismissed === true;
  const priorAnswers = answersFromResult(result);
  // `drafts` holds the typed text: a text question's value, or a single/multi
  // question's free-text box. The chosen options of a single/multi live in `picks`.
  // The two are independent — typed text is never matched against option labels.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (!resolved) {
      for (const q of questions) {
        if (q.type === "text" && q.defaultText !== undefined) init[q.id] = q.defaultText;
      }
    }
    for (const a of priorAnswers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (q?.type === "multi") {
        const opts = q.options ?? [];
        const extra = (a.values ?? splitMulti(a.value)).filter((s) => !opts.includes(s));
        if (extra.length) init[q.id] = extra.join(MULTI_SEP);
      } else if (q?.type === "single") {
        // Restore only: a stored value that is one of the options was a pick.
        if (!(q.options ?? []).includes(a.value)) init[q.id] = a.value;
      } else {
        init[a.questionId] = a.value;
      }
    }
    return init;
  });
  const [picks, setPicks] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    if (!resolved) {
      for (const q of questions) {
        if (q.type === "multi" && q.defaults) init[q.id] = [...new Set(q.defaults)];
        if (q.type === "single" && q.defaults?.length) init[q.id] = [q.defaults[0]];
      }
    }
    for (const a of priorAnswers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (q?.type === "multi") {
        const opts = q.options ?? [];
        const chosen = (a.values ?? splitMulti(a.value)).filter((s) => opts.includes(s));
        if (chosen.length) init[q.id] = chosen;
      } else if (q?.type === "single" && (q.options ?? []).includes(a.value)) {
        init[q.id] = [a.value];
      }
    }
    return init;
  });
  const [sent, setSent] = useState(false);

  const locked = resolved || sent;
  // Optional questions never block submit; required ones need a non-empty answer
  // (for single/multi: an option picked, or something typed in free-text).
  const isAnswered = (q: Question) =>
    q.type === "text"
      ? (drafts[q.id] ?? "").trim().length > 0
      : (picks[q.id]?.length ?? 0) > 0 || (drafts[q.id] ?? "").trim().length > 0;
  const allAnswered = questions.every((q) => q.optional || isAnswered(q));

  if (questions.length === 0) return null;

  function togglePick(id: string, opt: string) {
    setPicks((p) => {
      const cur = p[id] ?? [];
      return { ...p, [id]: cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt] };
    });
  }

  /** Single: picking an option replaces (and clears) whatever was typed. */
  function pickSingle(id: string, opt: string) {
    setPicks((p) => ({ ...p, [id]: [opt] }));
    setDrafts((d) => ({ ...d, [id]: "" }));
  }

  /** Free-text box edit; for single, typing replaces (deselects) the picked option. */
  function typeOwn(q: Question, text: string) {
    setDrafts((d) => ({ ...d, [q.id]: text }));
    if (q.type === "single") setPicks((p) => ({ ...p, [q.id]: [] }));
  }

  function submit() {
    if (locked || !allAnswered) return;
    // Skip blank answers (only optional questions can be blank) so the agent
    // gets a clean set rather than empty-string values. A multi answer joins its
    // chosen options (plus any typed-own extra) into one comma-separated value.
    const answers: Answer[] = questions.flatMap((q) => {
      if (q.type === "multi") {
        const typed = (drafts[q.id] ?? "").trim();
        const parts = [...(picks[q.id] ?? []), ...(typed ? [typed] : [])];
        // Keep the display value readable, but retain parts when splitting it would lose labels.
        const values = parts.some((part) => part.includes(MULTI_SEP)) ? { values: parts } : {};
        return parts.length ? [{ questionId: q.id, value: parts.join(MULTI_SEP), ...values }] : [];
      }
      // Single: the typed text if any (it replaced the pick), else the picked option.
      const value =
        (drafts[q.id] ?? "").trim() || (q.type === "single" ? (picks[q.id]?.[0] ?? "") : "");
      return value ? [{ questionId: q.id, value }] : [];
    });
    const summary = answers.map((a) => a.value).join(" · ");
    setSent(true);
    onSubmit(toolUseId, { answers }, summary);
  }

  return (
    <div
      tabIndex={-1}
      data-chat-card
      data-chat-pending-card={!locked ? "" : undefined}
      className="mb-4 min-w-0 max-w-full rounded-12 border border-border bg-surface"
    >
      {header ? <div className="flex min-w-0 flex-col px-4 pt-3">{header}</div> : null}
      {/* A fieldset defaults to min-width: min-content, which can widen the card. */}
      <fieldset disabled={locked} className="min-w-0 px-4 pt-3 pb-2">
        <FieldGroup className="space-y-4">
          {questions.map((q) => (
            <Field key={q.id} className="space-y-2">
              <FieldLabel className="wrap-anywhere">
                {q.question}
                {q.optional ? (
                  <span className="ml-2 text-aux text-muted-foreground">
                    {t("questionCard.optional")}
                  </span>
                ) : null}
              </FieldLabel>
              {q.type === "single" || q.type === "multi" ? (
                // Long labels read better as left-aligned rows. The length
                // heuristic chooses that layout, not whether text may wrap:
                // even a short label can exceed a narrow column's width.
                (() => {
                  const multi = q.type === "multi";
                  const options = q.options ?? [];
                  const stacked = options.some((o) => o.length > 32 || descriptionOf(q, o));
                  return (
                    <div
                      className={
                        stacked ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"
                      }
                    >
                      {options.map((opt) => {
                        const selected = (picks[q.id] ?? []).includes(opt);
                        const description = descriptionOf(q, opt);
                        return (
                          <Button
                            key={opt}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="sm"
                            align={stacked ? "start" : "center"}
                            aria-pressed={selected}
                            onClick={() => (multi ? togglePick(q.id, opt) : pickSingle(q.id, opt))}
                            className={cn(
                              OPTION,
                              stacked && "w-full text-left",
                              description && "py-2",
                            )}
                          >
                            {description ? (
                              <span className="flex min-w-0 flex-col gap-1">
                                <span>{opt}</span>{" "}
                                <span
                                  className={cn(
                                    "text-aux",
                                    selected
                                      ? "text-primary-foreground/80"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {description}
                                </span>
                              </span>
                            ) : (
                              opt
                            )}
                          </Button>
                        );
                      })}
                      {/* freeText: a single-line box sitting with the options.
                          Its text is kept apart from the option picks and is
                          never matched against option labels. For single, the
                          last interaction wins: typing deselects the option and
                          picking an option clears the box. For multi it's an
                          extra answer alongside whatever options are pressed. */}
                      {q.freeText ? (
                        <Input
                          // Input defaults to `md`, which is a step taller than
                          // the options this sits with.
                          size="sm"
                          value={drafts[q.id] ?? ""}
                          onChange={(e) => typeOwn(q, e.target.value)}
                          placeholder={multi ? t("questionCard.addOwn") : t("questionCard.typeOwn")}
                          className={cn(
                            "max-w-full text-ui",
                            stacked ? "w-full" : "min-w-0 flex-1 basis-40",
                          )}
                        />
                      ) : null}
                    </div>
                  );
                })()
              ) : (
                <Textarea
                  value={drafts[q.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                  rows={2}
                  className="resize-none"
                  placeholder={t("questionCard.typeAnswer")}
                />
              )}
            </Field>
          ))}
        </FieldGroup>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3">
        {locked ? (
          <span className="mr-auto text-aux text-muted-foreground">
            {dismissed ? t("questionCard.dismissed") : t("questionCard.answered")}
          </span>
        ) : null}
        {!locked && (
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(toolUseId)}>
              {t("questionCard.dismiss")}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={!allAnswered}>
              {t("questionCard.send")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
