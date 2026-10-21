/**
 * The platform a channel lives on, counted the way people count it: one
 * account cannot sign in to two platforms. A Telegram bot and a signed-in
 * Telegram user are one platform. Feishu and Lark are two platforms, but the
 * code still records a Lark app under the `feishu` kind of connection and
 * tells the two apart by the app's domain. It is a fixed value, never parsed
 * out of a channel's name. Vocabulary: docs/domains/chats.md#platform.
 */

/** Kinds of connection whose platform has another name. */
const PLATFORM_BY_KIND: Readonly<Record<string, string>> = {
  telegram_user: "telegram",
  wechat_user: "wechat",
  slack_bot: "slack",
};

/**
 * The platform an account of the connection kind `kind` lives on. Every kind
 * not listed names its own platform.
 * `domain` is the Feishu app's domain, and only `feishu` reads it: `lark` is
 * the Lark platform, and any other value or none is Feishu.
 * platformOf("feishu", "lark") returns "lark".
 */
export function platformOf(kind: string, domain?: string | null): string {
  if (kind === "feishu") return domain === "lark" ? "lark" : "feishu";
  return PLATFORM_BY_KIND[kind] ?? kind;
}
