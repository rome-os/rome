/** Message parts that are a widget: a card an app or core shows in a chat. */
const WIDGET_PART_TYPES: ReadonlySet<string> = new Set(["widget", "pending_interaction"]);

/**
 * A widget is a message of its own, so the message's id is the widget's id
 * (docs/domains/chats.md#widget). A message that holds a widget holds nothing
 * else; anything that would store a widget beside other parts is a bug.
 */
export function assertWidgetAlone(parts: readonly unknown[]): void {
  const widgets = parts.filter(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      WIDGET_PART_TYPES.has((part as { type?: unknown }).type as string),
  );
  if (widgets.length > 0 && parts.length !== 1) {
    throw new Error("A widget is a message of its own: it cannot share a message with other parts");
  }
}

/** {@link assertWidgetAlone} for stored content, a JSON array of parts. */
export function assertWidgetAloneInContent(content: string): void {
  if (!content.includes("widget") && !content.includes("pending_interaction")) return;
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return;
  }
  if (Array.isArray(parts)) assertWidgetAlone(parts);
}
