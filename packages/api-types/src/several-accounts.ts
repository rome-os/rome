/**
 * The services whose guardian can add a second account, each its own channel
 * with its own Connection. A service whose stores Rome keeps under its one
 * channel name (WhatsApp, LinkedIn, the personal WeChat), one that keeps its
 * adapter state in one place per profile (the WeChat bot), and one that is a
 * single presence by nature (webchat, email, the Cloud `agents` channel, the
 * signed-in Telegram user), stays single. Core checks it when it mints an
 * account and reports it on each Connection. Vocabulary:
 * docs/concepts/messaging.md#channels.
 */
export const SEVERAL_ACCOUNT_SERVICES: ReadonlySet<string> = new Set([
  "feishu",
  "telegram",
  "discord",
]);
