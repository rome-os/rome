// What `ask_question` takes and how a question reaches the guardian.

import { type Question, questionCardUi } from "@rome/api-types/question-card";

export { type Question, questionCardUi };

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// `ask_question` is a host built-in: the question card is described as data
// (`questionCardUi`) and every reader draws it, not an app. We
// still ride the existing pending-interaction render/resume path, which keys on
// an `appId`; "core" is the sentinel for a host-owned card (the webchat drain
// skips the app-installed check when `render.builtin` is set).
const ASK_QUESTION_APP_ID = "core";
const ASK_QUESTION_COMPONENT_ID = "question-card";

const ASK_QUESTION_PARK_DIRECTIVE =
  "The question card has been shown to the guardian. Their answers will arrive as the next turn's prompt — do not call any further tools or send another message until then. When you reply, describe only what this step does; do not claim a later step has already happened.";

/** What `ask_question` accepts, the same where it draws a card and where it
 * relays a plain message. Fails closed on a malformed questions array, so a
 * broken card never renders. */
export function parseAskQuestionInput(
  input: unknown,
): { ok: true; questions: Question[] } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "ask_question input must be an object" };
  }
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "ask_question.questions must be a non-empty array" };
  }
  for (const [i, q] of questions.entries()) {
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      return { ok: false, error: `ask_question.questions[${i}] must be an object` };
    }
    const o = q as Record<string, unknown>;
    if (!nonEmptyString(o.id)) {
      return { ok: false, error: `ask_question.questions[${i}].id is required` };
    }
    if (!nonEmptyString(o.question)) {
      return { ok: false, error: `ask_question.questions[${i}].question is required` };
    }
    if (o.type !== "single" && o.type !== "multi" && o.type !== "text") {
      return {
        ok: false,
        error: `ask_question.questions[${i}].type must be "single", "multi", or "text"`,
      };
    }
    if (o.type === "single" || o.type === "multi") {
      if (!Array.isArray(o.options) || o.options.length === 0) {
        return {
          ok: false,
          error: `ask_question.questions[${i}] is ${o.type}-choice and needs a non-empty options array`,
        };
      }
      // The web renderer drops non-string options, so a payload like
      // `options: [null]` would otherwise pass and render a choice card with
      // zero buttons — a dead, unanswerable parked turn. Reject up front.
      if (!o.options.every((opt) => nonEmptyString(opt) !== null)) {
        return {
          ok: false,
          error: `ask_question.questions[${i}].options must all be non-empty strings`,
        };
      }
    }
    if (o.defaults !== undefined) {
      if (
        o.type === "text" ||
        !Array.isArray(o.defaults) ||
        !o.defaults.every(
          (value) => typeof value === "string" && (o.options as string[]).includes(value),
        ) ||
        (o.type === "single" && o.defaults.length > 1)
      ) {
        return {
          ok: false,
          error: `ask_question.questions[${i}].defaults must be an array of existing option labels (at most one for single-choice, choice questions only)`,
        };
      }
    }
    if (o.defaultText !== undefined && (o.type !== "text" || typeof o.defaultText !== "string")) {
      return {
        ok: false,
        error: `ask_question.questions[${i}].defaultText must be a string on a text question`,
      };
    }
    if (o.optionDescriptions !== undefined) {
      const descriptions = o.optionDescriptions;
      if (
        o.type === "text" ||
        !descriptions ||
        typeof descriptions !== "object" ||
        Array.isArray(descriptions) ||
        !Object.entries(descriptions).every(
          ([label, description]) =>
            (o.options as string[]).includes(label) && typeof description === "string",
        )
      ) {
        return {
          ok: false,
          error: `ask_question.questions[${i}].optionDescriptions must map existing option labels to strings (choice questions only)`,
        };
      }
    }
  }
  return { ok: true, questions: questions as Question[] };
}

// The questions as a plain message, for where no card shows. The guardian
// replies in words and the answer arrives as the next turn.
function askQuestionsToPromptText(questions: readonly Question[]): string {
  return questions
    .map((q) => {
      const base = typeof q.question === "string" ? q.question : "";
      // Mark optional questions so the prose fallback reads the same as the card.
      const text = q.optional === true ? `${base} (optional)` : base;
      const hasOptions = q.type === "single" || q.type === "multi";
      const options =
        hasOptions && Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === "string")
          : [];
      if (!options.length) {
        return typeof q.defaultText === "string"
          ? `${text}\nDefault: ${q.defaultText || "(empty)"}`
          : text;
      }
      // multi-choice: tell the guardian they can name more than one.
      const head = q.type === "multi" ? `${text} (pick any that apply)` : text;
      const defaults = Array.isArray(q.defaults) ? q.defaults : [];
      const descriptions = q.optionDescriptions as Record<string, string> | undefined;
      const lines = options.map((o) => {
        const description = descriptions && Object.hasOwn(descriptions, o) ? descriptions[o] : "";
        return `- ${o}${defaults.includes(o) ? " (default)" : ""}${description ? ` — ${description}` : ""}`;
      });
      // freeText choice: tell the guardian they can also answer freely.
      if (hasOptions && q.freeText === true) lines.push("- (or describe your own)");
      return `${head}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * What a valid `ask_question` call hands back. Where a widget shows, the turn
 * parks on a question card and the `pendingInteraction` payload is what the
 * webchat drain reads; `builtin: true` makes it render the host's card, with
 * no app. Otherwise the model relays the questions as a plain message, so a
 * clarifying question never dead-ends.
 */
export function askQuestionToolOutput(
  questions: readonly Question[],
  widgetsShow: boolean,
): unknown {
  if (!widgetsShow) {
    return (
      "This surface cannot render an interactive UI. Ask the guardian the " +
      "following as a plain message, then wait for their reply before doing " +
      `anything else:\n\n${askQuestionsToPromptText(questions)}`
    );
  }
  return {
    pendingInteraction: true,
    appId: ASK_QUESTION_APP_ID,
    render: {
      kind: "inline",
      componentId: ASK_QUESTION_COMPONENT_ID,
      props: { questions },
      builtin: true,
    },
    message: ASK_QUESTION_PARK_DIRECTIVE,
  };
}

/** One answer as the question card has always sent it. A multi answer joins
 * its parts with ", " and keeps them in `values` when a part holds ", ". */
export interface QuestionAnswer {
  questionId: string;
  value: string;
  values?: string[];
}

/**
 * The answers a described question card sent, as the question card has
 * always sent them, or null when `output` is not from a described card.
 * Blank answers are left out, so only optional questions can go unanswered.
 * On a single-choice question the typed text wins over the pick.
 */
export function answersFromQuestionCard(
  questions: readonly Question[],
  output: unknown,
): { answers: QuestionAnswer[] } | null {
  const sent = (output as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(sent) || sent.some((a) => a && typeof a === "object" && "questionId" in a)) {
    return null;
  }
  const answers = questions.flatMap((q, i): QuestionAnswer[] => {
    const raw = (sent[i] ?? {}) as { values?: unknown; text?: unknown };
    const picked = Array.isArray(raw.values)
      ? raw.values.filter(
          (v): v is string => typeof v === "string" && (q.options ?? []).includes(v),
        )
      : [];
    const typed = typeof raw.text === "string" ? raw.text.trim() : "";
    if (q.type === "multi") {
      const parts = [...picked, ...(typed ? [typed] : [])];
      if (parts.length === 0) return [];
      const keep = parts.some((part) => part.includes(", ")) ? { values: parts } : {};
      return [{ questionId: q.id, value: parts.join(", "), ...keep }];
    }
    const value = typed || (q.type === "single" ? (picked[0] ?? "") : "");
    return value ? [{ questionId: q.id, value }] : [];
  });
  return { answers };
}

/**
 * What a described question card would have sent for `answers` in the shape
 * the question card has always sent, so a card answered by a reader that
 * draws its own question card shows the same answer when drawn from its
 * description. A value that is one of the options is a pick; the rest is
 * typed text.
 */
export function questionCardFromAnswers(
  questions: readonly Question[],
  output: unknown,
): { values: string[]; text: string }[] | null {
  const sent = (output as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(sent)) return null;
  const answers = sent.filter(
    (a): a is QuestionAnswer =>
      !!a &&
      typeof a === "object" &&
      typeof (a as QuestionAnswer).questionId === "string" &&
      typeof (a as QuestionAnswer).value === "string",
  );
  if (answers.length !== sent.length) return null;
  return questions.map((q) => {
    const answer = answers.find((a) => a.questionId === q.id);
    if (!answer) return { values: [], text: "" };
    if (q.type === "text") return { values: [], text: answer.value };
    const options = q.options ?? [];
    const parts =
      q.type === "multi"
        ? (answer.values ?? answer.value.split(", ")).map((part) => part.trim())
        : [answer.value];
    return {
      values: parts.filter((part) => options.includes(part)),
      text: parts.filter((part) => part && !options.includes(part)).join(", "),
    };
  });
}
