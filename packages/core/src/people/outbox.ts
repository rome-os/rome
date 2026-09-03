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

import type { OutboxMessage, OutboxState } from "@rome/api-types/people";
import type { MessageAccount, Messages } from "../channels/messages.js";
import { channelConversationId } from "../db/repositories/webchat.js";
import { conversationPlatformMessageId } from "../db/repositories/webchat.js";
import type { OutboxRepository, OutboxRow } from "../db/repositories/outbox.js";
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

/** What Rome writes into its own transcript when it sends. `senderId` is the
 *  mark every outbound path stamps, and `messages-agent.ts` reads it back to
 *  put the line on Rome's side of the conversation. */
const ROME_SENDER = { senderId: "rome", senderName: "Rome" } as const;

/** The slice of the conversation repository this needs: a channel thread's
 *  session, and Rome's own record of what it said there. Named as `ApiDeps`
 *  names it so no adapter sits between the two. */
export interface Conversations {
  ensureChannelConversation(input: {
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
  webchatRepo: Conversations;
}

export type SendResult = { ok: true; message: OutboxMessage } | { ok: false; send: RefusedState };

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
): Promise<SendResult> {
  const resolution = await resolveSendTarget(deps, account);
  if (!resolution.ok) return { ok: false, send: resolution.send };

  const row = await deps.outboxRepo.open({
    channel: account.channel,
    channelUserId: account.channelUserId,
    conversationId: resolution.target.conversationId,
    text,
  });

  return { ok: true, message: await attempt(deps, row, resolution.target) };
}

/** Send a `sending` row and record whichever way it went. Shared by the first
 *  attempt and by a retry, so the two cannot drift. */
async function attempt(
  deps: OutboxDeps,
  row: OutboxRow,
  target: SendTarget,
): Promise<OutboxMessage> {
  try {
    const receipt = await sendToTarget(deps, target, row.text);
    await deps.outboxRepo.accepted(row.id, receipt.messageId);
    // Rome's own transcript of what it said, the same record every other
    // outbound path writes. On a channel with no mirror of its own this IS the
    // timeline entry; on one with a mirror it sits behind the provider's copy,
    // which is the store precedence in timeline-sources.ts and not a special
    // case here.
    await record(deps, row, receipt.messageId);
    return wire({ ...row, state: "unconfirmed", providerMessageId: receipt.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.outboxRepo.refused(row.id, message);
    return wire({ ...row, state: "failed", error: message });
  }
}

/** Retry a failed send, under its own id so it does not read as a second
 *  message the guardian never wrote. */
export async function retrySend(deps: OutboxDeps, id: string): Promise<OutboxMessage | null> {
  const row = await deps.outboxRepo.reopen(id);
  if (row === null) return null;
  const resolution = await resolveSendTarget(deps, row);
  if (!resolution.ok) {
    const error = `cannot send on ${row.channel}: ${resolution.send}`;
    await deps.outboxRepo.refused(row.id, error);
    return wire({ ...row, state: "failed", error });
  }
  return attempt(deps, row, resolution.target);
}

async function record(deps: OutboxDeps, row: OutboxRow, messageId: string | null): Promise<void> {
  const conversation = await deps.webchatRepo.ensureChannelConversation({
    channel: row.channel,
    threadId: row.conversationId,
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
  stores: readonly Messages[],
  accounts: readonly MessageAccount[],
): Promise<OutboxMessage[]> {
  const rows = await deps.outboxRepo.forAccounts(
    accounts.flatMap((account) =>
      account.addresses.map((channelUserId) => ({ channel: account.channel, channelUserId })),
    ),
  );
  if (rows.length === 0) return [];

  const awaiting = rows.filter((row) => row.state === "unconfirmed");
  if (awaiting.length === 0) return rows.map(wire);

  const { entries } = await readPersonTimeline(stores, accounts, { limit: LANDING_WINDOW });
  const arrived = new Set(entries.map((entry) => entry.ref));

  // A row the channel accepted but never named cannot be recognized when it
  // arrives, so waiting on it is waiting forever. Clearing it is the lesser
  // wrong, and the requirement that makes it unreachable is stated on
  // `TalkDirectMessaging`.
  const landed = awaiting.filter(
    (row) => row.providerMessageId === null || refsFor(row).some((ref) => arrived.has(ref)),
  );
  await Promise.all(landed.map((row) => deps.outboxRepo.remove(row.id)));

  const cleared = new Set(landed.map((row) => row.id));
  return rows.filter((row) => !cleared.has(row.id)).map(wire);
}

/**
 * The two `ref`s a delivered message can carry, because two stores can hold it.
 *
 * A channel mirror keys its rows by the provider's own id under the
 * conversation (`wa_messages` is `chat_jid || ':' || id`). Rome's transcript
 * keys its own row by a digest of the session and that same provider id, which
 * is why `conversationPlatformMessageId` is derived and not random. Whichever
 * store ends up owning the account, one of these is the entry.
 *
 * Both need the provider's id, so a channel offering `directMessaging` has to
 * return one from `send` — see the note there. A send that is accepted without
 * one cannot be tracked, and the row is cleared rather than left waiting on an
 * answer that will never come.
 */
function refsFor(row: OutboxRow): string[] {
  if (row.providerMessageId === null) return [];
  const sessionId = channelConversationId(row.channel, row.conversationId);
  return [
    `${row.conversationId}:${row.providerMessageId}`,
    `agent:${conversationPlatformMessageId(sessionId, row.providerMessageId)}`,
  ];
}

function wire(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    channel: row.channel,
    channelUserId: row.channelUserId,
    text: row.text,
    timestamp: Math.floor(row.createdAt.getTime() / 1000),
    state: row.state as OutboxState,
    ref: refsFor(row)[0] ?? null,
    error: row.error,
  };
}
