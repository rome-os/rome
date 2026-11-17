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
  // A component no other one names is never drawn, so the text version and
  // the card would say different things.
  const named = new Set(card.components.flatMap(childIds));
  for (const c of card.components) {
    if (c.id !== "root" && !named.has(c.id)) {
      problems.push(`"${c.id}" is not a child of any component, so it would not show`);
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
      "The card is shown in your message. Don't repeat its numbers in your text: add only " +
      "what the card leaves out, such as sources, or nothing.",
  };
}
