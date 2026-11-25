/**
 * The steps that hear an [account code](docs/domains/identity.md#account-code)
 * in a message. A code Rome has seen in any message, heard live or read back
 * from a platform, is dead before anyone else is handed that message, so a
 * code is harmless wherever it is read later. What Rome has seen is all it
 * hands on: the text, the quoted message and the platform's raw payload. Only a direct message to an
 * [own account](docs/domains/chats.md#own-account) of Rome's whose whole text
 * is the code redeems it: that message is kept from the chat, so no
 * subscriber, agent or app hears it and it is not recorded, and Rome answers
 * there. Every other code is voided in silence.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../../connections/registry.js";
import {
  AccountCodeExpiredError,
  type AccountCodeContext,
  accountCodeRedeemed,
  AccountCodeUsedError,
  accountCodeVoided,
  looksLikeAccountCode,
  SignInAccountCodeError,
  UnknownAccountCodeError,
} from "../../identity/application/account-codes.js";
import { AccountTakenError } from "../../identity/identity.js";
import { accountCodesIn, normalizedAccountCode } from "../../lib/account-code-shape.js";
import { createLogger } from "../../logger.js";
import type { AccountLinkOf } from "./account-links.js";
import type { Admission, ReadBack } from "./admission.js";
import { sendThrough } from "./connection-ports.js";

const log = createLogger("account-code-admission");

/** What Rome answers the sender of a code. */
export const ACCOUNT_CODE_ANSWERS = {
  added: "This account is now connected to you.",
  expired: "This code has expired. Get a new one and send it again.",
  used: "This code has already been used. Get a new one and send it again.",
  unknown: "This code does not work. Check it, or get a new one.",
  taken: "This account is already connected to someone else, so it was not added.",
  signIn: "A code cannot connect an email address.",
} as const;

export interface AccountCodeAdmissionDeps {
  codes: AccountCodeContext;
  /** Whether Rome speaks as its own account on each kind of connection. */
  linkOf: AccountLinkOf;
  /** The connection each answer goes out on. */
  registry: Pick<ConnectionRegistry, "get">;
  /** The platform of the account that sent `message` on Connection
   *  `connectionId`, as Identity stores it. */
  platformOf: (connectionId: string, message: ChannelMessage) => string;
}

/**
 * Redeems a code that is the whole text of a direct message to an own account
 * for the sender's account, answers, and keeps the message from the chat. It
 * voids every other code the message carries, and in every other message
 * every code, and admits the message unless its text is a code alone in a
 * shared chat on an own account. Admits every message that carries no code
 * without a database read.
 */
export function accountCodeAdmission(deps: AccountCodeAdmissionDeps): Admission {
  return async (connectionId, connectionKind, message) => {
    const codes = accountCodesSeenIn(message);
    if (codes.length === 0) return true;
    const ownAccount = deps.linkOf(connectionKind) === "own_account";
    const direct = message.thread?.kind === "dm";
    const wholeText = looksLikeAccountCode(message.text);
    if (!ownAccount || !direct || !wholeText) {
      for (const code of codes) await accountCodeVoided(deps.codes, code);
      log.info("account code voided", { connectionId, codes: codes.length });
      return !(ownAccount && wholeText);
    }
    // The text's own code shows again in the raw payload; it is the one redeemed.
    const sent = normalizedAccountCode(message.text);
    const others = codes.filter((code) => code !== sent);
    for (const code of others) await accountCodeVoided(deps.codes, code);
    if (others.length > 0) log.info("account code voided", { connectionId, codes: others.length });
    const account = {
      platform: deps.platformOf(connectionId, message),
      accountId: message.senderId,
    };
    const outcome = await redeemed(deps.codes, message.text, account);
    log.info("account code heard", { connectionId, outcome });
    // The answer goes out in the background: admission holds the chat's next
    // message until it returns, and a send that hangs must not. A connection
    // removed since the message arrived fails the answer, not admission.
    const text = ACCOUNT_CODE_ANSWERS[outcome];
    Promise.resolve()
      .then(() => sendThrough(deps.registry.get(connectionId), message.chatId, { text }))
      .catch(() => {
        // Provider errors may include the rejected request body. Do not log them.
        log.error("account code answer failed", { connectionId });
      });
    return false;
  };
}

/**
 * Voids every code every message a history read answers carries, on
 * every channel, so a code Rome missed live is dead before the page is handed
 * on: one said where Rome's account hears only mentions, edited in later, or
 * kept only in a copy Rome mirrors, such as the guardian's own WhatsApp
 * messages. A page with no code-shaped token costs no database read.
 */
export function accountCodeReadBack(deps: Pick<AccountCodeAdmissionDeps, "codes">): ReadBack {
  const voided = async (codes: Set<string>) => {
    if (codes.size === 0) return;
    for (const code of codes) await accountCodeVoided(deps.codes, code);
    log.info("account code voided in a history read", { codes: codes.size });
  };
  return {
    messages: (page) => voided(new Set(page.flatMap(accountCodesSeenIn))),
    entries: (page) => voided(new Set(page.flatMap((entry) => accountCodesIn(entry.body ?? "")))),
  };
}

/**
 * Voids every code in a text a person typed where no connection carries it,
 * such as a dashboard chat, so the code is dead before the text is recorded or
 * handed to an agent. Nothing is redeemed there and the text is never
 * withheld. A text with no code-shaped token costs no database read.
 */
export function accountCodesVoidedIn(
  deps: Pick<AccountCodeAdmissionDeps, "codes">,
): (text: string) => Promise<void> {
  return async (text) => {
    const codes = new Set(accountCodesIn(text));
    if (codes.size === 0) return;
    for (const code of codes) await accountCodeVoided(deps.codes, code);
    log.info("account code voided in a dashboard message", { codes: codes.size });
  };
}

/**
 * Every code-shaped token in what Rome hands on with `message`: its text, the
 * text of the message it quotes, and the platform's raw payload, where a
 * reply can carry a quote no named field holds, such as Telegram's
 * `reply_to_message`. Empty for a message that carries none.
 */
export function accountCodesSeenIn(message: ChannelMessage): string[] {
  const codes = new Set(accountCodesIn(message.text));
  for (const code of accountCodesIn(message.replyTo?.content ?? "")) codes.add(code);
  if (message.raw !== undefined) {
    for (const code of accountCodesIn(serialized(message.raw))) codes.add(code);
  }
  return [...codes];
}

/**
 * `raw` as JSON, to search for codes: a code is letters, digits and dashes, so
 * JSON leaves it as typed. A platform's own objects serialize through their
 * `toJSON`. A big integer reads as its digits, and an object met again, as in
 * a cycle, is skipped, since its text was searched the first time.
 */
function serialized(raw: unknown): string {
  const met = new WeakSet<object>();
  try {
    return (
      JSON.stringify(raw, (_key, value: unknown) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "object" && value !== null) {
          if (met.has(value)) return undefined;
          met.add(value);
        }
        return value;
      }) ?? ""
    );
  } catch {
    // A `toJSON` that throws. The error may quote the payload, so it is not logged.
    log.warn("raw payload could not be searched for account codes");
    return "";
  }
}

async function redeemed(
  codes: AccountCodeContext,
  code: string,
  account: { platform: string; accountId: string },
): Promise<keyof typeof ACCOUNT_CODE_ANSWERS> {
  try {
    await accountCodeRedeemed(codes, code, account);
    return "added";
  } catch (error) {
    if (error instanceof AccountCodeExpiredError) return "expired";
    if (error instanceof AccountCodeUsedError) return "used";
    if (error instanceof UnknownAccountCodeError) return "unknown";
    if (error instanceof AccountTakenError) return "taken";
    if (error instanceof SignInAccountCodeError) return "signIn";
    throw error;
  }
}
