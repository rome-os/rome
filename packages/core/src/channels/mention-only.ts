/** Display name used when a channel cannot report the bot's own name. */
export const DEFAULT_BOT_DISPLAY_NAME = "Rome";

/**
 * Restores a mention-only message after an adapter strips the bot mention.
 *
 * Adapters remove the bot mention so the agent sees clean prose. When the
 * mention was the whole message, stripping leaves nothing, and the shared
 * inbox drops empty text. Returning the visible mention keeps the message and
 * records what the sender actually typed.
 */
export function preserveMentionOnlyText(
  text: string,
  mentionedBot: boolean,
  botName?: string,
): string {
  if (text || !mentionedBot) return text;
  return `@${botName?.trim() || DEFAULT_BOT_DISPLAY_NAME}`;
}
