/** How a place draws widgets: as cards, or as plain text (docs/domains/chats.md#widget). */
export type WidgetDrawing = "card" | "plain_text";

/** A subagent's next turn never comes back to it, so it never parks on a card. */
export function widgetDrawingFor(input: {
  placeDrawsCards: boolean;
  isSubagent: boolean;
}): WidgetDrawing {
  return input.placeDrawsCards && !input.isSubagent ? "card" : "plain_text";
}

/** A widget shows when the place draws it and a speaker is there to carry it. */
export function showsWidgets(widgets: WidgetDrawing, hasSpeaker: boolean): boolean {
  return widgets === "card" && hasSpeaker;
}
