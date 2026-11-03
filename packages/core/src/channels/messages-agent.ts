// `rome_agent_messages` as an {@link AccountMessages} store: what Rome was told and
// what it said back, for every channel with no mirror of its own.

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { MessagePart } from "../types.js";
import type { Message } from "@rome/api-types/message";
import type { AccountMessages, MessageDetail } from "./messages.js";
import { scopePairs, sqlMessages } from "./messages-sql.js";
import type { Account, ChatId } from "@rome-os/app-runtime";
import { CHAT_LINES, CHATS } from "../chats/storage/lines-sql.js";
import { addressOf, chatAt } from "../connections/chat-adapter.js";
import { chatKey } from "../connections/chat-ids.js";

/**
 * The sender id Rome stamps on a message it sent itself.
 *
 * Written by every outbound path that records a channel message — the
 * `send_message` action and the backend turn — and already how
 * `loadConversationContext` picks Rome's own rows out of the pending
 * notifications. Read here for the same reason: it is the one persisted mark
 * that survives a row whose role does not say which way it went.
 */
const ROME_SENDER_ID = "rome";

/**
 * Which way a stored agent message went, as SQL over its role and sender.
 *
 * The role alone cannot answer it. `assistant` is Rome's and `user` is the
 * person's, but `notification` is written in both directions:
 * `addConversationMessage` stores an inbound line that did not wake the agent
 * under it, and `recordOutboundConversationMessage` stores a *delivered* Rome
 * message under it whenever the send was not tied to a turn
 * (`knownToProvider: false`). Reading the role alone puts those replies on the
 * person's side of the conversation.
 *
 * So the sender settles what the role leaves open, and this is stated once for
 * both stores that read these rows: two spellings would put one message on two
 * sides.
 */
export function agentMessageOutbound(role: SQL, senderId: SQL): SQL {
  return sql`CASE
    WHEN ${role} = 'assistant' THEN 1
    -- Asked of a notification alone, and not as a rule over every row: a
    -- sender id is a provider's own opaque string, so a channel is free to
    -- hand out one that reads as Rome's marker. Where the role already
    -- answers, that collision decides nothing.
    WHEN ${role} = 'notification' AND ${senderId} = ${ROME_SENDER_ID} THEN 1
    ELSE 0
  END`;
}

/** {@link agentMessageOutbound} over one row already read, for a reader that
 *  holds the row rather than a query. */
export function isAgentMessageOutbound(role: string, senderId: string | null): boolean {
  return role === "assistant" || (role === "notification" && senderId === ROME_SENDER_ID);
}

/**
 * Rome's own transcript of a channel conversation, read for accounts.
 *
 * Reached through the session's thread. A channel session is keyed by the
 * thread it belongs to, so a session addressed by the account is that account's
 * direct conversation. A group's session is addressed by the group rather than
 * by anyone on it, so no account names it. Which sender a message carries makes
 * no difference: a line the account wrote into a group belongs to the group's
 * thread.
 */
export function agentMessages(db: DrizzleDb): AccountMessages {
  // No `channel`: the transcript holds every channel that has no mirror of its
  // own, side by side, so it is scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const addressed = scopePairs(scope.keys, sql`s.source_channel`, sql`s.source_thread_id`);
      if (addressed === null) return null;
      // Addressing already leaves a group out, since a group's session is keyed
      // by the group and no account answers to that. Said again on the store's
      // own terms so the guarantee survives a caller that hands over a group id
      // as if it were an account's address.
      const held = sql`${addressed} AND coalesce(s.source_thread_type, '') <> 'group'`;
      return sql`
        SELECT
          s.source_channel AS source,
          s.source_thread_id AS key,
          m.created_at AS at,
          ${agentMessageOutbound(sql`m.role`, sql`m.sender_id`)} AS outbound,
          'agent:' || m.id AS ref,
          m.content AS body,
          m.id AS detail_key
        FROM rome_agent_messages m
        JOIN rome_sessions s ON s.id = m.session_id
        WHERE s.type = 'channel'
          -- A guardian chat is the guardian talking to Rome, not a conversation
          -- with a person on an account.
          AND coalesce(s.source_channel, '') <> 'webchat'
          AND ${held}
          -- 'notification' is a line that passed outside a turn — something
          -- the person said without waking the agent, or something Rome sent
          -- untied to one. Either way it is conversation, and the direction
          -- above is what tells the two apart. 'trace' is the turn's own
          -- machinery and belongs to no conversation.
          AND m.role IN ('user', 'assistant', 'notification')`;
    },
    body: messageContentText,
    detail: {
      of: (key) => sql`(
        SELECT json_object(
          'senderId', m.sender_id,
          'senderName', m.sender_name,
          'threadId', s.source_thread_id,
          'threadName', s.source_thread_name,
          'threadType', s.source_thread_type
        )
        FROM rome_agent_messages m
        JOIN rome_sessions s ON s.id = m.session_id
        WHERE m.id = ${key}
      )`,
      map: transcriptDetail,
    },
  });
}

/**
 * Rome's own transcript of a channel conversation, read for accounts from
 * Chats: each direct message Rome's account on a channel has with the
 * account's address, every line said there. `accountsOn` names every account
 * Rome has spoken as on a channel, since a kept connection can be signed in as
 * another account and the chats its earlier account had stay keyed by it.
 *
 * The same store as {@link agentMessages}, over Chats' messages in place of
 * `rome_agent_messages`. A group answers to no address, and a guardian chat
 * is the guardian talking to Rome, so neither is read. A line is Rome's when
 * one of its agents said it, or when Rome's account said it, as the guardian
 * can through it. Vocabulary: docs/domains/chats.md.
 */
export function chatsAgentMessages(
  db: DrizzleDb,
  accountsOn: (channel: string) => readonly Account[],
): AccountMessages {
  return sqlMessages({
    db,
    view(scope) {
      if (scope.keys.length === 0) return null;
      // Rome's accounts once per channel, and the scope as one JSON value, so
      // a batch binds one variable however many keys it holds.
      const accounts = new Map<string, readonly Account[]>();
      const on = (channel: string) => {
        let held = accounts.get(channel);
        if (!held) accounts.set(channel, (held = accountsOn(channel)));
        return held;
      };
      const pairs = JSON.stringify(
        scope.keys.flatMap(({ channel, key }) =>
          on(channel).map((account) => {
            // The direct message the address names before Rome's account has
            // heard it anywhere else; the address store below has the last word.
            const named = chatAt(account.platform, key, { romeEnd: account.id }).externalId;
            return [channel, account.platform, account.id, key, named];
          }),
        ),
      );
      return sql`
        WITH v(channel, platform, account, key, named) AS (
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
            json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
          FROM json_each(${pairs})
        ),
        -- The direct message each address names: the one Rome's account heard
        -- there, else the one with the party the address names.
        dm(channel, platform, account, key, chat) AS (
          SELECT v.channel, v.platform, v.account, v.key, coalesce((
            SELECT a.chat_key FROM chat_addresses a
            WHERE a.platform = v.platform AND a.account_id = v.account
              AND a.address = v.key AND a.thread_id = ''
          ), v.named)
          FROM v
        )
        SELECT
          v.channel AS source,
          v.key AS key,
          m.said_at AS at,
          (m.sender_agent IS NOT NULL OR m.sender_account_id IS v.account) AS outbound,
          'agent:' || m.id AS ref,
          m.parts AS body,
          json_array(m.id, v.account) AS detail_key
        FROM dm v
        JOIN ${CHATS} c ON c.platform = v.platform AND c.key = v.chat
        JOIN ${CHAT_LINES} m ON m.chat_id = c.id AND m.thread_id IS NULL
        WHERE c.kind = 'dm' AND c.platform <> 'webchat'`;
    },
    body: messageContentText,
    detail: {
      // The line, and Rome's account at its end of the direct message.
      of: (key) => sql`(
        SELECT json_object(
          'senderId', m.sender_account_id,
          'senderName', m.sender_name,
          'chatKey', c.key,
          'platform', c.platform,
          'accountId', json_extract(${key}, '$[1]'),
          'threadName', c.name,
          -- Where Rome's account reaches the direct message, when it heard it
          -- at an address other than the chat's key.
          'address', (SELECT a.address FROM chat_addresses a
            WHERE a.platform = c.platform AND a.account_id = json_extract(${key}, '$[1]')
              AND a.chat_key = c.key AND a.thread_id = '')
        )
        FROM ${CHAT_LINES} m
        JOIN ${CHATS} c ON c.id = m.chat_id
        WHERE m.id = json_extract(${key}, '$[0]')
      )`,
      map: chatsTranscriptDetail,
    },
  });
}

/** Who said a line of a direct message, and the direct message, named by the
 *  address Rome's account reaches it at: the one it heard it at, else the
 *  other party. Rome's own lines carry no sender. */
function chatsTranscriptDetail(raw: Record<string, unknown>, entry: Message): MessageDetail {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const detail: MessageDetail = {};
  const sender = { id: text(raw.senderId), name: text(raw.senderName) };
  if (entry.direction === "inbound" && (sender.id !== null || sender.name !== null)) {
    detail.sender = sender;
  }
  const key = text(raw.chatKey);
  const platform = text(raw.platform);
  if (key !== null && platform !== null) {
    detail.conversation = {
      id: text(raw.address) ?? addressOf(chatKey(platform, key as ChatId)),
      name: text(raw.threadName),
      kind: "dm",
    };
  }
  return detail;
}

/** Who said a transcript line and in which session's thread, as the row
 *  recorded them. Rome's own lines carry no sender, the way the sentinel log
 *  reads them. A private thread is a direct one, and a thread type with no kind
 *  of its own reads as unknown. */
function transcriptDetail(raw: Record<string, unknown>, entry: Message): MessageDetail {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const detail: MessageDetail = {};
  const sender = { id: text(raw.senderId), name: text(raw.senderName) };
  if (entry.direction === "inbound" && (sender.id !== null || sender.name !== null)) {
    detail.sender = sender;
  }
  const threadId = text(raw.threadId);
  if (threadId !== null) {
    const type = text(raw.threadType);
    detail.conversation = {
      id: threadId,
      name: text(raw.threadName),
      kind: type === "private" ? "dm" : type === "group" || type === "topic" ? type : null,
    };
  }
  return detail;
}

/** The line a stored agent message renders as: its text parts, joined.
 *  Non-text parts (cards, recaps, errors) carry no conversation, nor does a
 *  dashboard turn's narration on its way to the answer (a commentary part).
 *  Content that does not parse is a row with nothing to show rather than a
 *  failed read. */
export function messageContentText(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed
    .filter((part): part is Extract<MessagePart, { type: "text" }> => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; content?: unknown; turnPhase?: unknown };
      return (
        candidate.type === "text" &&
        typeof candidate.content === "string" &&
        candidate.turnPhase !== "commentary"
      );
    })
    .map((part) => part.content)
    .join("\n");
  return text.length > 0 ? text : null;
}
