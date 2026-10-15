/**
 * The platform a channel lives on, counted the way people count it. Feishu and
 * Lark are one platform, and a Telegram bot and a signed-in Telegram user are
 * one platform. It is a fixed value, never parsed out of a channel's name, and
 * the one-agent-per-platform rule keys on it. Vocabulary:
 * docs/concepts/messaging.md#channels.
 */

/** Services whose platform is another service's name. Feishu and Lark already
 *  share the `feishu` service, so they need no entry. */
const PLATFORM_BY_SERVICE: Readonly<Record<string, string>> = {
  telegram_user: "telegram",
  wechat_user: "wechat",
};

/** The platform `service` belongs to. Every service not listed is its own. */
export function platformOf(service: string): string {
  return PLATFORM_BY_SERVICE[service] ?? service;
}
