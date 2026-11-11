// Saying a message in a chat from outside an agent turn, wherever the chat
// lives. Vocabulary: docs/domains/chats.md#place and
// docs/domains/chats.md#delivery. The wire answers are the People contract's
// (`@rome/api-types/people`).
//
// A send names a place, never an account. Reaching an account directly is
// finding the place first, which `people/send.ts` does for the People and
// assistants surfaces.
//
// Chats owns the answer and which side says the message; it says nothing
// itself. A platform Rome serves itself, such as the dashboard's, supplies its
// own side. Every other platform is reached through a Connection
// (`connections/send.ts`).

import type { Account } from "@rome-os/app-runtime";
import type { AccountSendState, SentMessage } from "@rome/api-types/people";
import { sendOnConnection, type SendIntoPlaceDeps } from "../connections/send.js";
import type { Delivery } from "./delivery.js";
import type { Place } from "./place.js";

/** What a message says. Text only, for now. */
export interface Body {
  text: string;
  /** Skill for a dashboard turn. Other platforms send only the text. */
  skillName?: string;
}

export type RefusedState = Exclude<AccountSendState, "yes">;

/** A send's answer: the platform took it, Rome refused before asking the
 *  platform, the platform refused in its own words, or the request named a
 *  sender Rome cannot send as. Once the platform was asked, `delivery` says
 *  how the message stands with it. */
export type SendResult =
  | { ok: true; sent: SentMessage; delivery: Delivery }
  | { ok: false; send: RefusedState }
  | { ok: false; error: string; delivery: Delivery }
  | { ok: false; invalid: string };

/**
 * Who a send goes out as: one of Rome's accounts, or, over today's storage,
 * the channel that stands for one no record names yet.
 */
export type Sender = Account | { readonly channel: string };

/** One platform's side of a send: say `body` in `place` as `as`. */
export type PlatformSend = (place: Place, body: Body, as?: Sender) => Promise<SendResult>;

export interface ChatSendDeps extends SendIntoPlaceDeps {
  /** The platforms Rome serves itself, each with its side of a send. A send
   *  on any platform not named here goes out on a Connection. */
  ownPlatforms?: ReadonlyMap<string, PlatformSend>;
}

/**
 * Say `body` in `place` as `as`, one of Rome's accounts on the place's
 * platform, and answer whether the platform took it. Which accounts may be
 * named, and what an absent `as` means, is the platform side's to say.
 */
export async function send(
  deps: ChatSendDeps,
  place: Place,
  body: Body,
  as?: Sender,
): Promise<SendResult> {
  const own = deps.ownPlatforms?.get(place.chat.platform);
  return own ? await own(place, body, as) : await sendOnConnection(deps, place, body, as);
}
