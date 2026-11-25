/**
 * The steps that hear an [account code](docs/domains/identity.md#account-code)
 * in a message. A code Rome has seen in any message, heard live or read back
 * from a platform, is dead before anyone else is handed that message, so a
 * code is harmless wherever it is read later. Only a direct message to an
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
import { accountCodesIn } from "../../lib/account-code-shape.js";
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
 * for the sender's account, answers, and keeps the message from the chat. In
 * every other message it voids every code-shaped token in the text, and
 * admits the message unless it is a code alone in a shared chat on an own
 * account. Admits every message that holds no code without a database read.
 */
export function accountCodeAdmission(deps: AccountCodeAdmissionDeps): Admission {
  return async (connectionId, connectionKind, message) => {
    const codes = accountCodesIn(message.text);
    if (codes.length === 0) return true;
    const ownAccount = deps.linkOf(connectionKind) === "own_account";
    const direct = message.thread?.kind === "dm";
    const wholeText = looksLikeAccountCode(message.text);
    if (!ownAccount || !direct || !wholeText) {
      for (const code of codes) await accountCodeVoided(deps.codes, code);
      log.info("account code voided", { connectionId, codes: codes.length });
      return !(ownAccount && wholeText);
    }
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
 * Voids every code-shaped token in every message a history read answers, on
 * every kind of connection, so a code Rome missed live, such as one said
 * where Rome's account hears only mentions or edited in later, is dead before
 * the page is handed on. A page with no code-shaped token costs no database
 * read.
 */
export function accountCodeReadBack(deps: Pick<AccountCodeAdmissionDeps, "codes">): ReadBack {
  return async (messages) => {
    const codes = new Set(messages.flatMap((message) => accountCodesIn(message.text)));
    if (codes.size === 0) return;
    for (const code of codes) await accountCodeVoided(deps.codes, code);
    log.info("account code voided in a history read", { codes: codes.size });
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
