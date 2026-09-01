/** Preserves a stripped mention-only message as the visible bot mention. */
export function preserveMentionOnlyText(
  text: string,
  mentionedBot: boolean,
  botName?: string,
): string {
  if (text || !mentionedBot) return text;
  return `@${botName?.trim() || "Rome"}`;
}
