/**
 * The steps that hear an [account code](docs/domains/identity.md#account-code)
 * sent to an [own account](docs/domains/chats.md#own-account) of Rome's. A
 * message whose whole text is a code is kept from the chat, so no subscriber,
 * agent or app hears it and it is not recorded. In a direct message the code
 * adds the sender's account to the person the code belongs to, and Rome
 * answers there. Anywhere else every code in the text is voided in silence,
 * since everyone in that chat has seen it, and a longer message is then heard
 * as an ordinary one. A history read from the platform leaves out every
 * message whose whole text is a code, and a message that quotes one is handed
 * on without the quote, live or read. On the guardian's own account a message
 * is to the guardian, not to Rome, so a code there is an ordinary message.
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
import { accountCodesIn } from "../../lib/account-code-shape.js";
import { createLogger } from "../../logger.js";
import type { AccountLinkOf } from "./account-links.js";
import type { Admission, HandedOn } from "./admission.js";
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
 * Keeps every message whose whole text is shaped like a code from the chat on
 * a connection to an own account, redeeming the code for the sender's account
 * in a direct message. Anywhere else it voids every code-shaped token in the
 * text, and admits a longer message. Admits every message that holds no code
 * without a database read.
 */
export function accountCodeAdmission(deps: AccountCodeAdmissionDeps): Admission {
  return async (connectionId, connectionKind, message) => {
    const codes = accountCodesIn(message.text);
    if (codes.length === 0) return true;
    if (deps.linkOf(connectionKind) !== "own_account") return true;
    const wholeText = looksLikeAccountCode(message.text);
    if (message.thread?.kind !== "dm") {
      for (const code of codes) await accountCodeVoided(deps.codes, code);
      log.info("account code voided in a shared chat", { connectionId, codes: codes.length });
      return !wholeText;
    }
    if (!wholeText) return true;
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
 * A message on a connection to an own account as a subscriber or a history
 * reader is handed it. One whose whole text is shaped like a code is left
 * out: live delivery never handed it on, so a read must not either, and a
 * code refused there may still be usable. One that quotes such a message
 * keeps its reply reference without the quoted text. Nothing is redeemed,
 * voided or read from the database: the code was handled when it was sent.
 */
export function withoutAccountCodes(deps: Pick<AccountCodeAdmissionDeps, "linkOf">): HandedOn {
  return (connectionKind, message) => {
    const isCode = looksLikeAccountCode(message.text);
    const quoted = message.replyTo?.content;
    const quotesCode = quoted !== undefined && looksLikeAccountCode(quoted);
    if (!isCode && !quotesCode) return message;
    if (deps.linkOf(connectionKind) !== "own_account") return message;
    if (isCode) return null;
    const { content: _code, ...replyTo } = message.replyTo!;
    return { ...message, replyTo };
  };
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
