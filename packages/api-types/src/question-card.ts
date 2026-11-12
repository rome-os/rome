// The question card `ask_question` shows, described as data. Core stores it
// with the card; the dashboard's mock data and gallery describe theirs with it.

import type { WidgetUi, WidgetUiComponent, WidgetUiCondition } from "@rome-os/app-runtime";

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

/**
 * The question card described as data, so every reader draws it from the same
 * description. The card's data model holds one `{ values, text }` per question,
 * in order: the picked options and the typed text. Send answers the waiting
 * turn with `{ answers: <that list> }`, which core turns into the answer
 * shape the card has always sent (`answersFromQuestionCard`).
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
        // On a single choice the last of a pick and typed text wins, as the
        // guardian sees it.
        ...(q.type === "single" && q.freeText === true ? { clears: { path: `${at}/text` } } : {}),
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
        ...(q.type === "single" ? { clears: { path: `${at}/values` } } : {}),
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
