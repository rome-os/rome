import { LayoutTemplate } from "lucide-react";
import type { ReplyInteractionBlock } from "../../trace/types.js";

// Read-only reproductions of the interaction cards the chat page shows inline.
//
// The live chat renders an agent's `pending_interaction` as either the host
// built-in `question-card` (QuestionCard.tsx) or an app-provided component
// mounted from the app's bundle (AppComponentView.tsx). A showcase replay is
// static and must stay distributable (no host/app bundles to mount), so we
// reproduce the *resolved* state read-only: the built-in question-card is
// rebuilt faithfully from its props + the guardian's answer; an app component
// can't be re-mounted here, so it degrades to a labelled placeholder that names
// the source and summarises the guardian's response.

interface Question {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
}

interface Answer {
  questionId: string;
  value: string;
}

const MULTI_SEP = ", ";

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
    return [{ id: o.id, question: o.question, type, options }];
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

const pillBase = "inline-flex h-7 items-center rounded-8 border px-2.5 text-xs font-medium";
const pillSelected = "border-transparent bg-primary text-primary-foreground";
const pillIdle = "border-border bg-background text-muted-foreground";

// Faithful read-only rebuild of the host built-in question-card's resolved
// state: each question with its options, the chosen ones highlighted, and an
// "Answered" footer (mirrors QuestionCard.tsx with the form locked).
function ReplayQuestionCard({
  props,
  result,
}: {
  props?: Record<string, unknown>;
  result?: Record<string, unknown>;
}) {
  const questions = parseQuestions(props);
  if (questions.length === 0) return null;
  const answers = answersFromResult(result);
  const valueFor = (qid: string) => answers.find((a) => a.questionId === qid)?.value ?? "";

  return (
    <div className="mb-3 rounded-12 border border-border bg-surface">
      <div className="space-y-5 p-4">
        {questions.map((q) => {
          const value = valueFor(q.id);
          const chosen = q.type === "multi" ? splitMulti(value) : value ? [value] : [];
          return (
            <div key={q.id} className="space-y-2">
              <div className="block text-sm font-medium text-foreground">{q.question}</div>
              {q.type === "text" ? (
                <div className="whitespace-pre-wrap text-sm text-foreground">{value || "—"}</div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Listed options, with the picked ones highlighted. */}
                  {(q.options ?? []).map((opt) => (
                    <span
                      key={opt}
                      className={`${pillBase} ${chosen.includes(opt) ? pillSelected : pillIdle}`}
                    >
                      {opt}
                    </span>
                  ))}
                  {/* Free-text / typed-own answers that aren't in the option list. */}
                  {chosen
                    .filter((c) => !(q.options ?? []).includes(c))
                    .map((extra) => (
                      <span key={extra} className={`${pillBase} ${pillSelected}`}>
                        {extra}
                      </span>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {result !== undefined ? "Answered" : "Asked by Rome"}
      </div>
    </div>
  );
}

// One-line summary of the guardian's response to an app component card, for the
// placeholder that stands in for a component we can't re-mount.
function summarizeResponse(result: Record<string, unknown> | undefined): string | null {
  if (!result) return null;
  if (result.dismissed === true) return "Dismissed";
  if (result.skip === true) return "Skipped";
  const answers = answersFromResult(result);
  if (answers.length > 0) return answers.map((a) => a.value).join(" · ");
  if (typeof result.summary === "string" && result.summary.trim()) return result.summary.trim();
  const parts = Object.entries(result)
    .filter(([, v]) => v !== null && (typeof v !== "object" || Array.isArray(v)))
    .map(([k, v]) => (v === true ? k : `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`));
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Placeholder for an app-provided interaction component (e.g. welcome-to-rome's
// email-handshake): names the source and shows the guardian's response, since
// the live component's own UI can't be re-mounted in a static replay.
function ReplayAppCard({
  appId,
  componentId,
  result,
}: {
  appId?: string;
  componentId: string;
  result?: Record<string, unknown>;
}) {
  const summary = summarizeResponse(result);
  const source = appId ? `${appId} · ${componentId}` : componentId;
  return (
    <div className="mb-3 rounded-12 border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground">
        <LayoutTemplate size={14} /> Interactive card · {source}
      </div>
      <div className="px-4 py-3 text-sm text-foreground">
        {summary ? (
          <>
            <span className="text-muted-foreground">Your response: </span>
            {summary}
          </>
        ) : (
          <span className="text-muted-foreground">No response recorded.</span>
        )}
      </div>
    </div>
  );
}

// Dispatch a captured interaction card to the right read-only renderer.
export function ReplayInteractionCard({ block }: { block: ReplyInteractionBlock }) {
  if (block.render.builtin && block.render.componentId === "question-card") {
    return <ReplayQuestionCard props={block.render.props} result={block.result} />;
  }
  return (
    <ReplayAppCard
      appId={block.appId}
      componentId={block.render.componentId}
      result={block.result}
    />
  );
}
