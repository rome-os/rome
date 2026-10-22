/**
 * The guardian's shortcut for linking one of their own accounts on any platform
 * ([Account](docs/domains/people.md#account)). People shows a code. A direct
 * message carrying it, sent to any of Rome's accounts, links the sender to the
 * guardian.
 *
 * The code is the only proof, so it is short-lived, single-use and one at a
 * time: showing a new code voids the last, five wrong codes void it, and a code
 * said anywhere but a direct message is voided rather than redeemed, since
 * everyone in that chat has seen it.
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { createLogger } from "../logger.js";
import type { Admission } from "./admission.js";
import { sendThrough } from "./connection-ports.js";

const log = createLogger("guardian-link-code");

const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 5;
// No 0/O or 1/I, so a code read off a screen and typed on a phone survives.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^ROME-[A-Z0-9]{8}$/i;

export interface LinkCode {
  code: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** The outstanding code. In memory only: a restart voids it, and the guardian
 *  asks People for another. */
export class GuardianLinkCodes {
  private current: (LinkCode & { failures: number }) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Mints a code and voids any earlier one. */
  issue(): LinkCode {
    let suffix = "";
    for (let i = 0; i < 8; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
    this.current = { code: `ROME-${suffix}`, expiresAt: this.now() + CODE_TTL_MS, failures: 0 };
    return { code: this.current.code, expiresAt: this.current.expiresAt };
  }

  /** True when `text` is the outstanding code, which it then uses up. A wrong
   *  code counts toward voiding it. */
  redeem(text: string): boolean {
    const current = this.live();
    if (!current) return false;
    if (this.matches(current.code, text)) {
      this.current = null;
      return true;
    }
    current.failures += 1;
    if (current.failures >= MAX_FAILURES) this.current = null;
    return false;
  }

  /** Voids the outstanding code when `text` is it. */
  burn(text: string): void {
    const current = this.live();
    if (current && this.matches(current.code, text)) this.current = null;
  }

  private live() {
    if (this.current && this.current.expiresAt <= this.now()) this.current = null;
    return this.current;
  }

  private matches(code: string, text: string): boolean {
    const submitted = Buffer.from(text.trim().toUpperCase());
    const expected = Buffer.from(code);
    return submitted.length === expected.length && timingSafeEqual(submitted, expected);
  }
}

export function isLinkCodeMessage(text: string | undefined): boolean {
  return CODE_PATTERN.test(text?.trim() ?? "");
}

/**
 * Takes a code-shaped message out of the chat before any subscriber hears it,
 * and redeems it when it came in a direct message. Every other message is
 * admitted.
 */
export function createGuardianLinkAdmission(deps: {
  codes: GuardianLinkCodes;
  personMappingRepo: Pick<PersonMappingRepository, "findByBondLevel" | "linkAccount">;
  registry: Pick<ConnectionRegistry, "get">;
}): Admission {
  return async (connectionId, connectionKind, message) => {
    if (!isLinkCodeMessage(message.text)) return true;
    // Replies go out in the background: admission holds the chat's next
    // message until it returns, and a send that hangs must not.
    const reply = (text: string): void => {
      sendThrough(deps.registry.get(connectionId), message.chatId, { text }).catch(() => {
        // Provider errors may include the rejected request body. Do not log them.
        log.error("link code reply failed", { connectionId });
      });
    };
    if (message.thread?.kind !== "dm") {
      deps.codes.burn(message.text!);
      return false;
    }
    // A Telegram channel posts under the channel's own negative id, which is no
    // person's account.
    if (connectionKind === "telegram" && !/^[1-9][0-9]*$/.test(message.senderId)) return false;
    // The email adapter namespaces mail that failed SPF, DKIM or DMARC, whose
    // From anyone can forge. It proves no account, so the code stays unused and
    // no reply goes to an address the sender may not own.
    if (message.senderId.startsWith("unauthenticated:")) return false;
    if (!deps.codes.redeem(message.text!)) {
      reply("That code was not accepted. Open People in Rome to get a new one.");
      return false;
    }
    const [guardian] = await deps.personMappingRepo.findByBondLevel("guardian");
    if (!guardian) return false;
    const result = await deps.personMappingRepo.linkAccount({
      personId: guardian.id,
      channel: connectionKind,
      channelUserId: message.senderId,
    });
    log.info("link code redeemed", { connectionId, linked: result.linked });
    reply(
      result.linked
        ? "✅ This account is now linked to you in Rome."
        : "This account is linked to someone else in People. Move it to yourself there.",
    );
    return false;
  };
}
