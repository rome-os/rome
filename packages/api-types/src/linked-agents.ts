import { SEVERAL_ACCOUNT_SERVICES } from "./several-accounts.js";

/**
 * The services whose channels can be linked to an agent: the bots a guardian
 * adds to chats on behalf of an agent, and the signed-in Telegram user. A
 * channel that carries Rome's own traffic (the Cloud `agents` channel, webchat,
 * email) stays with main. Core checks it when it links an agent, and the
 * dashboard reads it to offer the picker. Invariants:
 * docs/concepts/messaging.md#channels.
 */
export const LINKABLE_SERVICES: ReadonlySet<string> = new Set([
  ...SEVERAL_ACCOUNT_SERVICES,
  "telegram_user",
]);
