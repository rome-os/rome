/**
 * The step that hears an [account code](docs/domains/identity.md#account-code)
 * sent to an [own account](docs/domains/chats.md#own-account) of Rome's. A
 * code in a direct message adds the sender's account to the person the code
 * belongs to, and Rome answers there. A code anywhere else is voided in
 * silence, since everyone in that chat has seen it. Either way the message is
 * kept from the chat, so no subscriber, agent or app hears it and it is not
 * recorded. On the guardian's own account a message is to the guardian, not
 * to Rome, so a code there is an ordinary message.
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
import { createLogger } from "../../logger.js";
import type { AccountLinkOf } from "./account-links.js";
import type { Admission } from "./admission.js";
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
 * in a direct message and voiding it anywhere else. Admits every other
 * message without a database read.
 */
export function accountCodeAdmission(deps: AccountCodeAdmissionDeps): Admission {
  return async (connectionId, connectionKind, message) => {
    if (!looksLikeAccountCode(message.text)) return true;
    if (deps.linkOf(connectionKind) !== "own_account") return true;
    if (message.thread?.kind !== "dm") {
      await accountCodeVoided(deps.codes, message.text);
      log.info("account code voided in a shared chat", { connectionId });
      return false;
    }
    // Answers go out in the background: admission holds the chat's next
    // message until it returns, and a send that hangs must not.
    const answer = (text: string): void => {
      sendThrough(deps.registry.get(connectionId), message.chatId, { text }).catch(() => {
        // Provider errors may include the rejected request body. Do not log them.
        log.error("account code answer failed", { connectionId });
      });
    };
    // A Telegram channel posts under the channel's own negative id, which is no
    // person's account.
    if (connectionKind === "telegram" && !/^[1-9][0-9]*$/.test(message.senderId)) return false;
    const account = {
      platform: deps.platformOf(connectionId, message),
      accountId: message.senderId,
    };
    const outcome = await redeemed(deps.codes, message.text, account);
    log.info("account code heard", { connectionId, outcome });
    answer(ACCOUNT_CODE_ANSWERS[outcome]);
    return false;
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
