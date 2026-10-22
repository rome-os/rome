// The outbox: what Rome has been asked to send and has not yet seen arrive.
//
// The timeline is what happened; this is what is still being attempted. Two
// nouns rather than a delivery status on a timeline entry, because a timeline
// entry's `ref` has to stay unique and its ordering total — a cursor is written
// against them — and neither survives rows that may still be withdrawn.
//
// Nothing clears a row. A row is gone once its message is on the timeline, and
// this read is what notices. That is why there is no delivery callback to
// forget to call and no state the two reads can disagree about: an outbox row
// is exactly a send whose entry is not there yet.

import {
  matchesSendRequest,
  STRANDED_SEND_ERROR,
  type OutboxMessage,
} from "@rome/api-types/people";
import { createLogger } from "../logger.js";
import { heldOn, type AccountMessages, type MessageAccount } from "../channels/messages.js";
import { channelChatId } from "../db/repositories/webchat.js";
import { conversationPlatformMessageId } from "../db/repositories/webchat.js";
import type { OutboxAccount, OutboxRepository, OutboxRow } from "../db/repositories/outbox.js";
import { outboxMessage as wire } from "../db/repositories/outbox.js";
import {
  resolveSendTarget,
  sendToTarget,
  type RefusedState,
  type SendDeps,
  type SendTarget,
} from "./send.js";
import { readPersonTimeline } from "./timeline.js";

/** How far back the landing check looks. A message lands within a second of
 *  being accepted, so anything this deep is already an incident; the window is
 *  wide enough that a burst of sends cannot push an entry past it. */
const LANDING_WINDOW = 100;

/** How long a send may sit `sending` before it is treated as abandoned. A send
 *  is one provider call inside one request, so minutes here is generous — long
 *  enough that a slow channel is never called dead, short enough that a crash
 *  does not leave a row spinning until someone looks. */
const STRANDED_AFTER_MS = 5 * 60_000;

/** What Rome writes into its own transcript when it sends. `senderId` is the
 *  mark every outbound path stamps, and `messages-agent.ts` reads it back to
 *  put the line on Rome's side of the conversation. */
const ROME_SENDER = { senderId: "rome", senderName: "Rome" } as const;

const log = createLogger("people-outbox");

/** The slice of the conversation repository this needs: a channel thread's
 *  session, and Rome's own record of what it said there. Named as `ApiDeps`
 *  names it so no adapter sits between the two. */
export interface ChatStore {
  ensureChannelChat(input: {
    channel: string;
    threadId: string;
    agentName?: string;
  }): Promise<{ id: string }>;
  recordOutboundConversationMessage(input: {
    sessionId: string;
    content: string;
    platformMessageId?: string;
    senderId?: string;
    senderName?: string;
    knownToProvider: boolean;
  }): Promise<void>;
}

export interface OutboxDeps extends SendDeps {
  outboxRepo: OutboxRepository;
  webchatRepo: ChatStore;
}

export type SendResult =
  | { ok: true; message: OutboxMessage }
  | { ok: false; send: RefusedState }
  | { ok: false; error: string }
  | { ok: false; invalid: string };

/**
 * Send to one account, and answer with the outbox row it became.
 *
 * The row is written before the channel is called, so a process that dies
 * mid-send leaves a `sending` row rather than nothing at all. It is never
 * written as delivered: the channel accepting a message is not the same fact
 * as the message being on the timeline, and only the read below can see the
 * second one.
 */
export async function sendToAccount(
  deps: OutboxDeps,
  account: { channel: string; channelUserId: string },
  text: string,
  id?: string,
  from?: string,
  senders?: readonly string[],
): Promise<SendResult> {
  const replay = (message: OutboxMessage): SendResult =>
    matchesSendRequest(message, { ...account, text, ...(from === undefined ? {} : { from }) })
      ? { ok: true, message }
      : { ok: false, error: "That send id belongs to a different message" };
  if (id) {
    const existing = await deps.outboxRepo.findSend(id);
    if (existing) return replay(existing);
  }
  // Checked for a new send only, after the replay above: the account a
  // recorded send named may since be gone.
  if (from !== undefined && senders !== undefined && !senders.includes(from)) {
    return { ok: false, invalid: "Rome holds no account by that id that can send to this account" };
  }
  const resolution = await resolveSendTarget(deps, account, from);
  if (!resolution.ok) return { ok: false, send: resolution.send };

  const input = {
    channel: account.channel,
    channelUserId: account.channelUserId,
    chatId: resolution.target.chatId,
    text,
    from: resolution.target.channel,
  };
  const claimed = id ? await deps.outboxRepo.openOnce({ ...input, id }) : null;
  if (claimed && !claimed.created) return replay(claimed.message);
  const row = claimed?.row ?? (await deps.outboxRepo.open(input));

  return { ok: true, message: await attempt(deps, row, resolution.target) };
}

/**
 * Send a `sending` row and record whichever way it went. Shared by the first
 * attempt and by a retry, so the two cannot drift.
 *
 * Only the provider call decides whether this failed. Once it returns, the
 * message is out on a network Rome does not own and no local mishap can take
 * it back — so the acceptance is written first and alone, and everything after
 * it is bookkeeping that may fail without changing what happened. Wrapping the
 * two together reported a delivered message as refused, which invites a retry
 * and a second real message to someone who already got the first.
 */
async function attempt(
  deps: OutboxDeps,
  row: OutboxRow,
  target: SendTarget,
): Promise<OutboxMessage> {
  let receipt: Awaited<ReturnType<typeof sendToTarget>>;
  try {
    receipt = await sendToTarget(target, row.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.outboxRepo.refused(row.id, message);
    return wire({ ...row, state: "failed", error: message });
  }

  await deps.outboxRepo.accepted(row.id, receipt.messageId);

  // Rome's own transcript of what it said, the same record every other outbound
  // path writes. On a channel with no mirror of its own this IS the timeline
  // entry; on one with a mirror it sits behind the provider's copy, which is
  // the store precedence in timeline-sources.ts and not a special case here.
  //
  // A failure here leaves the row `unconfirmed`, which is the truth: the
  // message was sent and Rome cannot yet see it. On a mirrored channel the
  // provider's own copy still lands and clears the row; on an unmirrored one
  // the row stays, visibly, which is the outbox doing its job.
  try {
    await record(deps, row, target.channel, receipt.messageId);
  } catch (error) {
    log.warn("outbound message delivered but recording failed", {
      outboxId: row.id,
      channel: row.channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // `accepted` restarted the row's clock, and the window a discard waits out
  // runs from it.
  return wire({
    ...row,
    state: "unconfirmed",
    providerMessageId: receipt.messageId,
    updatedAt: new Date(),
  });
}

/**
 * Retry a failed send, under its own id so it does not read as a second
 * message the guardian never wrote.
 *
 * Scoped to the accounts given. A message id is not a capability: the route
 * that reaches this names a person, and a row belonging to someone else is not
 * that person's to move, however plausible the id looks.
 */
export async function retrySend(
  deps: OutboxDeps,
  accounts: readonly OutboxAccount[],
  id: string,
): Promise<OutboxMessage | null> {
  if (!(await heldBy(deps, accounts, id))) return null;
  const row = await deps.outboxRepo.reopen(id);
  if (row === null) return null;
  // From the account it went out from the first time, and no other.
  const resolution = await resolveSendTarget(deps, row, sentFrom(row));
  if (!resolution.ok) {
    const error = `cannot send on ${row.channel}: ${resolution.send}`;
    await deps.outboxRepo.refused(row.id, error);
    return wire({ ...row, state: "failed", error });
  }
  if (resolution.target.chatId !== row.chatId) {
    const error = "The account's conversation changed. Discard this reply and compose a new one.";
    await deps.outboxRepo.refused(row.id, error);
    return wire({ ...row, state: "failed", error });
  }
  return attempt(deps, row, resolution.target);
}

/** Give up on a failed send of this person's. Answers whether there was one to
 *  give up on, so the route can tell a wrong id from a done job. */
export async function discardSend(
  deps: OutboxDeps,
  accounts: readonly OutboxAccount[],
  id: string,
): Promise<boolean> {
  if (!(await heldBy(deps, accounts, id))) return false;
  return await deps.outboxRepo.discard(id);
}

/** Whether a row is addressed to one of these accounts. */
async function heldBy(
  deps: OutboxDeps,
  accounts: readonly OutboxAccount[],
  id: string,
): Promise<boolean> {
  const row = await deps.outboxRepo.find(id);
  return (
    row !== null &&
    accounts.some(
      (account) => account.channel === row.channel && account.channelUserId === row.channelUserId,
    )
  );
}

/** Written under the channel that sent, the one the row's link reaches, so
 *  the line joins the conversation Rome holds there. */
async function record(
  deps: OutboxDeps,
  row: OutboxRow,
  channel: string,
  messageId: string | null,
): Promise<void> {
  const conversation = await deps.webchatRepo.ensureChannelChat({
    channel,
    threadId: row.chatId,
  });
  await deps.webchatRepo.recordOutboundConversationMessage({
    sessionId: conversation.id,
    content: JSON.stringify([{ type: "text", content: row.text }]),
    ...(messageId ? { platformMessageId: messageId } : {}),
    ...ROME_SENDER,
    // False: this line was not produced by an agent turn. It decides the role
    // the row is stored under, which `agentMessageOutbound` then reads back
    // together with the sender to put it on Rome's side.
    knownToProvider: false,
  });
}

/**
 * Every send for these accounts that has not arrived, clearing the ones that
 * have.
 *
 * The check is exact rather than approximate: a delivered message's `ref` is
 * predictable from the id the channel gave back, in both of the two forms a
 * store can produce. Matching on anything looser — the text, a timestamp
 * window — would clear a row on a message the guardian sent from their phone.
 */
export async function readOutbox(
  deps: OutboxDeps,
  stores: readonly AccountMessages[],
  accounts: readonly MessageAccount[],
): Promise<OutboxMessage[]> {
  const rows = await deps.outboxRepo.forAccounts(
    accounts.flatMap((account) =>
      account.addresses.map((channelUserId) => ({ channel: account.channel, channelUserId })),
    ),
  );
  if (rows.length === 0) return [];

  // A row still `sending` long after its attempt began is one whose process
  // died between the insert and the channel's answer. Nothing will ever move
  // it, so the read that notices says so: it becomes a failed row the guardian
  // can see and retry, carrying the only honest error there is. It is not
  // cleared — the message may well have gone out.
  const now = new Date();
  const stale = now.getTime() - STRANDED_AFTER_MS;
  const stranded = rows.filter((row) => row.state === "sending" && row.updatedAt.getTime() < stale);
  for (const row of stranded) {
    await deps.outboxRepo.stranded(row.id, STRANDED_SEND_ERROR);
    row.state = "failed";
    row.error = STRANDED_SEND_ERROR;
  }

  const awaiting = rows.filter((row) => row.state === "unconfirmed");
  if (awaiting.length === 0) return rows.map((row) => wire(row, now));

  // Each row is looked for under the account it went out from and nowhere
  // else, so a message another of Rome's accounts holds under the same
  // provider id cannot clear it. Rows that landed on one account share one
  // read of it.
  const reads = new Map<string, Promise<Set<string>>>();
  const refsOn = (account: MessageAccount): Promise<Set<string>> => {
    const key = JSON.stringify([account.channel, account.storedUnder, account.addresses]);
    let read = reads.get(key);
    if (read === undefined) {
      read = readPersonTimeline(stores, [account], { limit: LANDING_WINDOW }).then(
        ({ entries }) => new Set(entries.map((entry) => entry.ref)),
      );
      reads.set(key, read);
    }
    return read;
  };
  const arrived = await Promise.all(
    awaiting.map(async (row) => {
      const account = landingAccount(accounts, row);
      const refs = await refsOn(account);
      return refsFor(row, account).some((ref) => refs.has(ref));
    }),
  );

  // A row the channel accepted but never named cannot be recognized when it
  // arrives, so waiting on it is waiting forever. Clearing it is the lesser
  // wrong, and the requirement that makes it unreachable is stated on
  // `ChannelDirectMessaging`.
  const landed = awaiting.filter(
    (row, index) => row.providerMessageId === null || arrived[index] === true,
  );
  await Promise.all(landed.map((row) => deps.outboxRepo.remove(row.id)));

  const cleared = new Set(landed.map((row) => row.id));
  return rows.filter((row) => !cleared.has(row.id)).map((row) => wire(row, now));
}

/**
 * Every `ref` a delivered message could carry, because two stores can hold it
 * and one of them keys by an address the send did not necessarily name.
 *
 * A channel mirror keys its rows by the provider's id under the conversation
 * (`wa_messages` is `chat_jid || ':' || id`). Rome's transcript keys its own
 * row by a digest of the session and that same provider id, which is why
 * `conversationPlatformMessageId` is derived and not random.
 *
 * The mirror form is generated over every address of the account, not only the
 * one the send was addressed to. A channel folds several addresses onto one
 * account — WhatsApp reaches a contact as both a phone JID and an `@lid`, and
 * holds a chat under each — so a message sent to one can be echoed back under
 * the other. Predicting only the address we sent to left the row waiting on a
 * ref that would never appear, which is a send accepted and then stuck.
 *
 * The transcript form names the channel the send went out on, which
 * `landingAccount` reads the account under.
 *
 * All of them need the provider's id, so a channel offering `directMessaging`
 * has to return one from `send` — see the note there. A send accepted without
 * one cannot be tracked, and the row is cleared rather than left waiting on an
 * answer that will never come.
 */
function refsFor(row: OutboxRow, account: MessageAccount): string[] {
  const messageId = row.providerMessageId;
  if (messageId === null) return [];
  const refs = [
    `${row.chatId}:${messageId}`,
    ...new Set(account.addresses.map((address) => `${address}:${messageId}`)),
  ];
  const channel = heldOn(account);
  if (channel !== null) {
    const sessionId = channelChatId(channel, row.chatId);
    refs.push(`agent:${conversationPlatformMessageId(sessionId, messageId)}`);
  }
  return refs;
}

/** The channel of the account a row went out from. A row written before that
 *  was recorded went out from the channel its link names exactly, since People
 *  then reached no other. */
function sentFrom(row: OutboxRow): string {
  return row.from ?? row.channel;
}

/** This row's account, with every address the channel folds onto it, the
 *  row's own included, read under the channel the row went out from. Falls
 *  back to the row's own address for a channel that folds nothing. */
function landingAccount(accounts: readonly MessageAccount[], row: OutboxRow): MessageAccount {
  const account = accounts.find(
    (candidate) =>
      candidate.channel === row.channel && candidate.addresses.includes(row.channelUserId),
  ) ?? { channel: row.channel, addresses: [row.channelUserId] };
  return { ...account, storedUnder: sentFrom(row) };
}
