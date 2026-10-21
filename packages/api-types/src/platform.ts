/**
 * The platform a channel lives on, counted the way people count it: one
 * account cannot sign in to two platforms. A Telegram bot and a signed-in
 * Telegram user are one platform. Feishu and Lark share the `feishu` service
 * but are two platforms, told apart by the app's domain. It is a fixed value,
 * never parsed out of a channel's name. Vocabulary:
 * docs/domains/chats.md#platform.
 */

/** Services whose platform is another service's name. */
const PLATFORM_BY_SERVICE: Readonly<Record<string, string>> = {
  telegram_user: "telegram",
  wechat_user: "wechat",
  slack_bot: "slack",
};

/**
 * The platform `service` belongs to. Every service not listed is its own.
 * `domain` is the Feishu app's domain, and only `feishu` reads it: `lark` is
 * the Lark platform, and any other value or none is Feishu.
 * platformOf("feishu", "lark") returns "lark".
 */
export function platformOf(service: string, domain?: string | null): string {
  if (service === "feishu") return domain === "lark" ? "lark" : "feishu";
  return PLATFORM_BY_SERVICE[service] ?? service;
}
