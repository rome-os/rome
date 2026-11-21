// One of a person's accounts: its messages, paged, and saying something to it.
// Both refuse an account the person does not hold, so neither reads or sends
// for someone else.

import type { Account } from "@rome-os/app-runtime";
import type { SendMessageRequest, TimelinePage } from "@rome/api-types/people";
import type { Message } from "@rome/api-types/message";
import { send, type ChatSendDeps, type SendResult } from "../../../chats/send.js";
import { accountOfWire } from "../../model/wire.js";
import type { PeopleRepository } from "../../model/people-repository.js";
import { asGuardian, directPlace } from "./send.js";
import { readAccountTimeline } from "./timeline.js";
import { guardianChannels, personMessageStores, timelineAccounts } from "./timeline-sources.js";

export type AccountMessagesDeps = ChatSendDeps &
  Parameters<typeof personMessageStores>[0] &
  Parameters<typeof timelineAccounts>[0] & {
    peopleRepo: Pick<PeopleRepository, "all" | "byId">;
  };

/** Why a person's account was not read or sent to before Rome looked further. */
export type AccountRefusal = { refused: "unknown person" | "not linked" };

async function heldAccount(
  deps: Pick<AccountMessagesDeps, "peopleRepo">,
  personId: string,
  account: Account,
): Promise<{ links: Account[] } | AccountRefusal> {
  const person = await deps.peopleRepo.byId(personId);
  if (!person) return { refused: "unknown person" };
  const held = person.links.some(
    (link) => link.platform === account.platform && link.id === account.id,
  );
  return held ? { links: person.links } : { refused: "not linked" };
}

/**
 * Say something to one of a person's accounts, from one of the guardian's own
 * accounts on its platform (`asGuardian`). The account the message goes out
 * from has to be one of Rome's accounts on the link's platform. Rome never
 * substitutes another for it.
 */
export async function sendToAccount(
  deps: AccountMessagesDeps,
  personId: string,
  request: SendMessageRequest,
): Promise<SendResult | AccountRefusal> {
  const account = accountOfWire(request);
  const held = await heldAccount(deps, personId, account);
  if (!("links" in held)) return held;
  // TODO(people-send-from dashboard PR): require `from` once the dashboard
  // sends it. Until then a send without it goes out from Rome's only account
  // on the platform, and is refused while Rome holds several.
  const guardians = await guardianChannels(deps);
  const found = await directPlace(asGuardian(deps, guardians), account, request.from);
  if (!found.ok) return found;
  return send(deps, found.place, { text: request.text }, found.as);
}

/**
 * One of a person's accounts, its history paged newest first. A person has no
 * history joined across their accounts, so the account is required.
 */
export async function readAccountMessages(
  deps: AccountMessagesDeps,
  personId: string,
  account: Account,
  page: { cursor: Message | null; limit: number },
): Promise<TimelinePage | AccountRefusal> {
  const held = await heldAccount(deps, personId, account);
  if (!("links" in held)) return held;
  // The fold puts every address of the account on it, so the link is matched
  // by its address among them, the rule the person read's `latestAt` uses too.
  const guardians = await guardianChannels(deps);
  const [accounts] = await timelineAccounts({ ...deps, guardians }, [held.links]);
  return readAccountTimeline(
    personMessageStores(deps),
    (accounts ?? []).filter(
      (entry) => entry.channel === account.platform && entry.addresses.includes(account.id),
    ),
    page,
  );
}
