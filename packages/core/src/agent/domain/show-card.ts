// What `show_card` takes and how an agent's own card reaches the guardian.
// A card the model writes is display only: it shows text and numbers, and
// can neither press anything, read a URL, nor call an app. So no output of
// any tool can make it do more than a message could.

import {
  checkWidgetUi,
  childIds,
  type WidgetUi,
  type WidgetUiComponentName,
} from "@rome-os/app-runtime";

/** The app id of a card the host owns rather than an app. */
export const SHOW_CARD_APP_ID = "core";

/** The components a `show_card` card may use: no `Button`, no inputs, and no
 *  `Image`, whose URL a reader would load by itself. */
export const SHOW_CARD_COMPONENTS: readonly WidgetUiComponentName[] = [
  "Text",
  "Stat",
  "Progress",
  "Row",
  "Column",
  "List",
];

/** At most this many components, so one card cannot fill the chat. */
export const SHOW_CARD_MAX_COMPONENTS = 60;
/** At most this many characters of JSON for the card and its data. */
export const SHOW_CARD_MAX_CHARS = 16_000;

/**
 * The problems that keep `ui` from showing as an agent's card, or an empty
 * list. Run where the tool answers and again where the chat stores the card,
 * since tool output is not proof of where it came from.
 */
export function checkShowCard(ui: unknown): string[] {
  const problems = checkWidgetUi(ui, {});
  if (problems.length > 0) return problems;
  const card = ui as WidgetUi;
  if (card.components.length > SHOW_CARD_MAX_COMPONENTS) {
    problems.push(`the card has more than ${SHOW_CARD_MAX_COMPONENTS} components`);
  }
  if (JSON.stringify(card).length > SHOW_CARD_MAX_CHARS) {
    problems.push(`the card is longer than ${SHOW_CARD_MAX_CHARS} characters`);
  }
  for (const c of card.components) {
    if (!SHOW_CARD_COMPONENTS.includes(c.component)) {
      problems.push(
        `"${c.id}" is a ${c.component}, which a card may not use (use ${SHOW_CARD_COMPONENTS.join(", ")})`,
      );
    }
  }
  // The card is a tree drawn once per component: a data model, a child drawn
  // once per array element, or a child two components name would let a short
  // card draw far more than its components, since a reader repeats a shared
  // child under each parent.
  if (card.data !== undefined) problems.push("the card may not have a data model");
  const parents = new Map<string, number>();
  for (const c of card.components) {
    // With no data model a `{ path }` reads nothing, and the reader would
    // draw a blank where the value should be.
    for (const [key, value] of Object.entries(c)) {
      if (value && typeof value === "object" && "path" in value) {
        problems.push(`"${c.id}".${key} reads a path; write the value itself`);
      }
    }
    if ("children" in c && !Array.isArray(c.children)) {
      problems.push(`"${c.id}" draws a child per array element; list its children by id`);
    }
    for (const child of childIds(c)) parents.set(child, (parents.get(child) ?? 0) + 1);
  }
  for (const c of card.components) {
    const count = parents.get(c.id) ?? 0;
    // A component no other one names is never drawn, so the text version and
    // the card would say different things.
    if (c.id !== "root" && count === 0) {
      problems.push(`"${c.id}" is not a child of any component, so it would not show`);
    } else if (count > 1 || (c.id === "root" && count > 0)) {
      problems.push(`"${c.id}" is named as a child more than once; give each its own id`);
    }
  }
  return problems;
}

/** What `show_card` accepts, checked the same way wherever it runs. */
export function parseShowCardInput(
  input: unknown,
): { ok: true; ui: WidgetUi; text: string } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "show_card input must be an object" };
  }
  const { ui, text } = input as Record<string, unknown>;
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "show_card.text must be the card's content as plain text" };
  }
  const problems = checkShowCard(ui);
  if (problems.length > 0) {
    return { ok: false, error: `show_card.ui is not valid: ${problems.join("; ")}` };
  }
  return { ok: true, ui: ui as WidgetUi, text: text.trim() };
}

/**
 * What a valid `show_card` call hands back. Where a widget shows, the webchat
 * drain stores the card from this output (`showWidget`, `appId`, `ui`,
 * `text`) and the turn goes on. Elsewhere the model is told to send the text
 * instead, so a report never goes missing.
 */
export function showCardToolOutput(ui: WidgetUi, text: string, widgetsShow: boolean): unknown {
  if (!widgetsShow) {
    return {
      message:
        "No card was shown, because this conversation cannot show cards. Send its content " +
        `as your message instead:\n\n${text}`,
    };
  }
  return {
    showWidget: true,
    appId: SHOW_CARD_APP_ID,
    ui,
    text,
    message:
      "The card is shown in your message. Still end your reply with text, at least one short " +
      "sentence, such as what stands out or the sources. It need not repeat what the card " +
      "shows: the card goes with your words, also when your conclusion is forwarded.",
  };
}
