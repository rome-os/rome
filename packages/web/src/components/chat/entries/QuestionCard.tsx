import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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
  /** single/multi only: also show a free-text box beneath the options. */
  freeText?: boolean;
  /** Question may be left blank without blocking submit. */
  optional?: boolean;
}

interface Answer {
  questionId: string;
  value: string;
}

/** How a multi-choice answer joins its selected options into one string value. */
const MULTI_SEP = ", ";

/**
 * An option can wrap, so it takes the `sm` step as a floor rather than as a
 * fixed height. One line sits under that floor, so the box is the step exactly
 * and the Button's own `items-center` centres the label; two lines outgrow it
 * and the box follows the text. Vertical padding is deliberately absent — any
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
    return [{ id: o.id, question: o.question, type, options, freeText, optional }];
  });
}

function answersFromResult(result: Record<string, unknown> | undefined): Answer[] {
  const raw = result?.answers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    if (typeof o.questionId !== "string" || typeof o.value !== "string") return [];
    return [{ questionId: o.questionId, value: o.value }];
  });
}

export interface QuestionCardProps {
  toolUseId: string;
  props?: Record<string, unknown>;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
  onDismiss: (toolUseId: string) => void;
}

export function QuestionCard({ toolUseId, props, result, onSubmit, onDismiss }: QuestionCardProps) {
  const { t } = useTranslation("chat");
  const questions = parseQuestions(props);
  const resolved = result !== undefined;
  // Dismissed (the guardian skipped the card — tapped Dismiss, or answered in
  // chat, which auto-dismisses it) vs answered through the card.
  const dismissed = resolved && (result as { dismissed?: unknown }).dismissed === true;
  const priorAnswers = answersFromResult(result);
  // `drafts` holds the single/text value, and — for a multi question — only its
  // typed-own free-text remainder. The chosen options of a multi live in `picks`.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of priorAnswers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (q?.type === "multi") {
        const opts = q.options ?? [];
        const extra = splitMulti(a.value).filter((s) => !opts.includes(s));
        if (extra.length) init[q.id] = extra.join(MULTI_SEP);
      } else {
        init[a.questionId] = a.value;
      }
    }
    return init;
  });
  const [picks, setPicks] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const a of priorAnswers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (q?.type !== "multi") continue;
      const opts = q.options ?? [];
      const chosen = splitMulti(a.value).filter((s) => opts.includes(s));
      if (chosen.length) init[q.id] = chosen;
    }
    return init;
  });
  const [sent, setSent] = useState(false);

  const locked = resolved || sent;
  // Optional questions never block submit; required ones need a non-empty answer
  // (for multi: at least one option picked, or something typed in free-text).
  const isAnswered = (q: Question) =>
    q.type === "multi"
      ? (picks[q.id]?.length ?? 0) > 0 || (drafts[q.id] ?? "").trim().length > 0
      : (drafts[q.id] ?? "").trim().length > 0;
  const allAnswered = questions.every((q) => q.optional || isAnswered(q));

  if (questions.length === 0) return null;

  function togglePick(id: string, opt: string) {
    setPicks((p) => {
      const cur = p[id] ?? [];
      return { ...p, [id]: cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt] };
    });
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
        return parts.length ? [{ questionId: q.id, value: parts.join(MULTI_SEP) }] : [];
      }
      const value = (drafts[q.id] ?? "").trim();
      return value ? [{ questionId: q.id, value }] : [];
    });
    const summary = answers.map((a) => a.value).join(" · ");
    setSent(true);
    onSubmit(toolUseId, { answers }, summary);
  }

  return (
    <div className="mb-4 min-w-0 max-w-full rounded-12 border border-border bg-surface">
      {/* A fieldset defaults to min-width: min-content, which can widen the card. */}
      <fieldset disabled={locked} className="min-w-0 p-4">
        <FieldGroup className="space-y-5">
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
                  const stacked = options.some((o) => o.length > 32);
                  return (
                    <div
                      className={
                        stacked ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"
                      }
                    >
                      {options.map((opt) => {
                        const selected = multi
                          ? (picks[q.id] ?? []).includes(opt)
                          : drafts[q.id] === opt;
                        return (
                          <Button
                            key={opt}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="sm"
                            align={stacked ? "start" : "center"}
                            aria-pressed={selected}
                            onClick={() =>
                              multi
                                ? togglePick(q.id, opt)
                                : setDrafts((d) => ({ ...d, [q.id]: opt }))
                            }
                            className={cn(OPTION, stacked && "w-full text-left")}
                          >
                            {opt}
                          </Button>
                        );
                      })}
                      {/* freeText: a single-line box sitting with the options.
                          For single, typing here IS the answer (a value not
                          matching any option), so it shows empty whenever a
                          listed option is the pick. For multi it's an extra
                          answer alongside whatever options are pressed. */}
                      {q.freeText ? (
                        <Input
                          // Input defaults to `md`, which is a step taller than
                          // the options this sits with.
                          size="sm"
                          value={
                            multi || !options.includes(drafts[q.id]) ? (drafts[q.id] ?? "") : ""
                          }
                          onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
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

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-aux text-muted-foreground">
          {locked
            ? dismissed
              ? t("questionCard.dismissed")
              : t("questionCard.answered")
            : t("questionCard.askedByRome")}
        </span>
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
