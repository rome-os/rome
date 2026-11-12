/**
 * Message parts only the host may author. A routine card can create, pause and
 * delete routines, so only the webchat drain writes one (directly to the
 * repository). Every outbound path that stores sender-supplied parts —
 * `send_message`, `channels.send`, a People send — strips them, so a forged card
 * can't bind those controls to a routine or schedule an arbitrary action. A
 * connect card makes the dashboard open a link and call an API path it carries,
 * so only the Concierge's own tool may write one. A widget mounts an app's code
 * with the props it carries, so only the webchat drain writes one, for the app
 * that owns the action that showed it.
 */
const HOST_ONLY_PART_TYPES: ReadonlySet<string> = new Set([
  "routine_draft_card",
  "quota_switch",
  "connect_card",
  "widget",
]);

export function withoutHostOnlyParts<T extends { type: string }>(parts: readonly T[]): T[] {
  return parts.filter((part) => !HOST_ONLY_PART_TYPES.has(part.type));
}

/** The same strip for a stored content string (a JSON array of parts). Content
 * that isn't such an array is returned unchanged. */
export function stripHostOnlyPartsFromContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed)) return content;
  const kept = parsed.filter(
    (part) =>
      !(
        part &&
        typeof part === "object" &&
        HOST_ONLY_PART_TYPES.has((part as { type?: unknown }).type as string)
      ),
  );
  return kept.length === parsed.length ? content : JSON.stringify(kept);
}
