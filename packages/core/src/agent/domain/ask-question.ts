// What `ask_question` takes and how a question reaches the guardian.

import type { WidgetUi, WidgetUiComponent, WidgetUiCondition } from "@rome-os/app-runtime";

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// `ask_question` is a host built-in: the question-card is rendered by rome-web
// directly (see packages/web .../blocks/QuestionCard.tsx), not by an app. We
// still ride the existing pending-interaction render/resume path, which keys on
// an `appId`; "core" is the sentinel for a host-owned card (the webchat drain
// skips the app-installed check when `render.builtin` is set).
const ASK_QUESTION_APP_ID = "core";
const ASK_QUESTION_COMPONENT_ID = "question-card";

const ASK_QUESTION_PARK_DIRECTIVE =
  "The question card has been shown to the guardian. Their answers will arrive as the next turn's prompt — do not call any further tools or send another message until then. When you reply, describe only what this step does; do not claim a later step has already happened.";

/** One question as the model asked it. Any other field it sent rides along to the card. */
export interface Question {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
  defaults?: string[];
  defaultText?: string;
  optionDescriptions?: Record<string, string>;
  freeText?: boolean;
  optional?: boolean;
  [field: string]: unknown;
}

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
      // The same card described as data. Readers that know `ui` draw it;
      // older ones draw their own question card from `props`.
      ui: questionCardUi(questions),
      builtin: true,
    },
    message: ASK_QUESTION_PARK_DIRECTIVE,
  };
}

/**
 * The question card described as data, so every reader draws it from the same
 * description. The card's data model holds one `{ values, text }` per question,
 * in order: the picked options and the typed text. Send answers the waiting
 * turn with `{ answers: <that list> }`, which {@link answersFromQuestionCard}
 * turns into the answer shape the card has always sent.
 */
export function questionCardUi(questions: readonly Question[]): WidgetUi {
  const components: WidgetUiComponent[] = [];
  const rows: string[] = [];
  const required: WidgetUiCondition[] = [];
  questions.forEach((q, i) => {
    const at = `/answers/${i}`;
    const head = `q${i}`;
    const parts = [`${head}-title`];
    components.push({ id: `${head}-text`, component: "Text", text: q.question, variant: "h5" });
    if (q.optional === true) {
      components.push({
        id: `${head}-optional`,
        component: "Text",
        text: { string: "optional" },
        variant: "caption",
      });
    }
    components.push({
      id: `${head}-title`,
      component: "Row",
      children: q.optional === true ? [`${head}-text`, `${head}-optional`] : [`${head}-text`],
    });
    const answered: WidgetUiCondition[] = [];
    if (q.type !== "text") {
      const descriptions = q.optionDescriptions ?? {};
      components.push({
        id: `${head}-pick`,
        component: "ChoicePicker",
        variant: q.type === "multi" ? "multipleSelection" : "mutuallyExclusive",
        options: (q.options ?? []).map((option) => ({
          label: option,
          value: option,
          ...(Object.hasOwn(descriptions, option) ? { description: descriptions[option] } : {}),
        })),
        value: { path: `${at}/values` },
      });
      parts.push(`${head}-pick`);
      answered.push({ call: "required", args: { value: { path: `${at}/values` } } });
    }
    if (q.type === "text" || q.freeText === true) {
      components.push({
        id: `${head}-own`,
        component: "TextField",
        label: q.question,
        value: { path: `${at}/text` },
        variant: q.type === "text" ? "longText" : "shortText",
        placeholder: {
          string: q.type === "text" ? "typeAnswer" : q.type === "multi" ? "addOwn" : "typeOwn",
        },
      });
      parts.push(`${head}-own`);
      answered.push({ call: "required", args: { value: { path: `${at}/text` } } });
    }
    components.push({ id: head, component: "Column", children: parts });
    rows.push(head);
    if (q.optional !== true) {
      required.push(
        answered.length === 1 ? answered[0] : { call: "or", args: { values: answered } },
      );
    }
  });
  components.push(
    { id: "send-label", component: "Text", text: { string: "send" } },
    {
      id: "send",
      component: "Button",
      child: "send-label",
      variant: "primary",
      action: { event: { name: "rome:answer", context: { answers: { path: "/answers" } } } },
      checks: required.map((condition) => ({ condition, message: "" })),
    },
    { id: "dismiss-label", component: "Text", text: { string: "dismiss" } },
    {
      id: "dismiss",
      component: "Button",
      child: "dismiss-label",
      variant: "borderless",
      action: { event: { name: "rome:dismiss" } },
    },
    { id: "actions", component: "Row", children: ["dismiss", "send"], justify: "end" },
    { id: "root", component: "Column", children: [...rows, "actions"] },
  );
  return {
    components,
    data: {
      answers: questions.map((q) => ({
        values: q.type === "single" ? (q.defaults ?? []).slice(0, 1) : (q.defaults ?? []),
        text: q.type === "text" ? (q.defaultText ?? "") : "",
      })),
    },
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
