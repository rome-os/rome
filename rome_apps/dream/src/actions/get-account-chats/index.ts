// Recent chats on every one of Rome's accounts, read from Rome's own
// transcript. Accounts and channels: docs/architecture/channels.md.
import { sql } from "drizzle-orm";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
  isCoreMainAgentId,
} from "@rome-os/app-runtime";
import { ACCOUNT_KINDS, onRomeAccount } from "../../lib/chat-activity.js";
import type { ChatLine } from "@rome-os/app-runtime/chats";
import { chatReadsOf } from "../../lib/chat-lines.js";
import { extractText } from "../../lib/message-text.js";

const log = createAppLogger("get_account_chats");

// What is kept, so busy chats cannot crowd the other sources out of Dream's
// context: the newest lines per chat, the characters per line, and the
// characters across every chat, spent on the most recently active chats first.
const MESSAGES_PER_CHAT = 50;
const CHARS_PER_MESSAGE = 1000;
const CHARS_IN_ALL = 60_000;

const ACCOUNT_SEPARATOR = "\n\n---\n\n";

// The agent that answers a chat, over `rome_sessions s` and `channels c`, by
// core's rule (`answeringAgentName` in
// packages/core/src/db/repositories/session-query.ts): on an account with an
// agent, a private chat and a chat stored as main take the account's agent,
// unless the chat is pinned to main. Main reads as null.
const ACCOUNT_AGENT = sql`CASE WHEN c.agent IN ('main', 'core:main') THEN NULL ELSE c.agent END`;
const ANSWERING_AGENT = sql`CASE WHEN c.agent IS NOT NULL THEN CASE
    WHEN s.source_thread_type IS 'private' THEN ${ACCOUNT_AGENT}
    WHEN coalesce(json_type(s.channel_settings, '$.overrides.routing.agentName') = 'null', 0) = 1 THEN NULL
    WHEN coalesce(s.agent_name, 'main') IN ('main', 'core:main') THEN ${ACCOUNT_AGENT}
    ELSE s.agent_name END
  ELSE s.agent_name END`;

interface MessageRow {
  session_id: string;
  session_name: string;
  thread_name: string | null;
  channel: string;
  connection_kind: string;
  platform: string;
  role: string;
  /** The agent that answers the chat, by core's rule; null for main. */
  agent_name: string | null;
  outbound: number;
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  created_at: number;
  /** Lines the chat holds in the window, kept or not. */
  chat_total: number;
  /** On a line another of Rome's accounts said in a shared chat, that
   *  account, whose agent this chat's answering agent is not. */
  other_account?: string;
}

interface Chat {
  account: string;
  name: string;
  total: number;
  messages: MessageRow[];
}

/** The heading an account is listed under. */
function accountHeading(row: MessageRow): string {
  const { platform } = row;
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  const kind = row.connection_kind !== platform ? ` (${row.connection_kind})` : "";
  return `### ${name} account \`${row.channel}\`${kind}`;
}

/** A name someone else chose, on one line and in quotes, so it can be read
 *  only as a name. */
function named(name: string): string {
  return JSON.stringify(name.replace(/\s+/g, " ").trim());
}

function speakerOf(row: MessageRow): string {
  if (row.other_account) return `Agent on Rome's account ${named(row.other_account)} (Rome)`;
  if (row.outbound) {
    // An account can be linked to an agent other than main, whose lines are
    // not Rome's own.
    const agent =
      row.agent_name && !isCoreMainAgentId(row.agent_name) ? ` ${named(row.agent_name)}` : "";
    return `Agent${agent} (Rome)`;
  }
  return `Person ${named(row.sender_name || row.sender_id || "unknown")}`;
}

/** A line as Dream reads it. The body is quoted, so what someone wrote can
 *  never pass for a heading or a speaker. */
function formatLine(m: MessageRow): string | null {
  const full = extractText(m.content);
  if (!full) return null;
  const text =
    full.length > CHARS_PER_MESSAGE ? `${full.slice(0, CHARS_PER_MESSAGE)}… (cut)` : full;
  const time = new Date(m.created_at * 1000).toISOString();
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `[${time}] **${speakerOf(m)}**:\n${quoted}`;
}

/** The chats as Dream reads them, and how many lines that shows. */
function formatChats(rows: MessageRow[]): { content: string; shown: number } {
  if (rows.length === 0) {
    return { content: "(No chats on Rome's accounts in the requested window.)", shown: 0 };
  }

  const headings = new Map<string, string>();
  const chats = new Map<string, Chat>();
  for (const row of rows) {
    if (!headings.has(row.channel)) headings.set(row.channel, accountHeading(row));
    let chat = chats.get(row.session_id);
    if (!chat) {
      chat = {
        account: row.channel,
        name: row.thread_name || row.session_name,
        total: row.chat_total,
        messages: [],
      };
      chats.set(row.session_id, chat);
    }
    chat.messages.push(row);
  }

  const lastAt = (chat: Chat) => chat.messages[chat.messages.length - 1]?.created_at ?? 0;
  const byRecent = [...chats.values()].sort((a, b) => lastAt(b) - lastAt(a));
  const kept = new Map<string, string[]>();
  // Spent on everything written, the closing note's room held back.
  let budget = CHARS_IN_ALL - 80;
  let shown = 0;
  let leftOut = 0;
  for (const chat of byRecent) {
    const lines = chat.messages.map(formatLine).filter((line): line is string => line !== null);
    if (lines.length === 0) continue;
    // The first chat kept for an account also writes the account's heading
    // and the separator before it.
    const accountCost = kept.has(chat.account)
      ? 2
      : (headings.get(chat.account)?.length ?? 0) + ACCOUNT_SEPARATOR.length + 2;
    const heading = `#### Chat ${named(chat.name)}\n\n`;
    // The newest lines that fit, so a busy chat is shortened rather than lost.
    const fitting: string[] = [];
    let used = accountCost + heading.length + 64;
    for (const line of [...lines].reverse()) {
      if (used + line.length + 2 > budget) break;
      used += line.length + 2;
      fitting.unshift(line);
    }
    if (fitting.length === 0) {
      leftOut += 1;
      continue;
    }
    // Lines with no readable text were never going to show, so they are not
    // counted as left out.
    const left = chat.total - (chat.messages.length - lines.length) - fitting.length;
    const note = left > 0 ? `(${left} earlier messages left out)\n\n` : "";
    const text = `${heading}${note}${fitting.join("\n\n")}`;
    budget -= accountCost + text.length;
    shown += fitting.length;
    kept.set(chat.account, [...(kept.get(chat.account) ?? []), text]);
  }

  const parts = [...kept].map(
    ([account, texts]) => `${headings.get(account)}\n\n${texts.join("\n\n")}`,
  );
  if (leftOut > 0) parts.push(`(${leftOut} more chats left out to keep this short.)`);
  const content =
    parts.length > 0 ? parts.join(ACCOUNT_SEPARATOR) : "(No readable messages found.)";
  return { content, shown };
}

/**
 * The account of Rome's a session speaks as, from the transcript it reads:
 * the sender of a line answering one of its turns, else the sender of every
 * line Rome said when there is only one. Null when the transcript cannot
 * tell.
 */
function accountOf(lines: ChatLine[]): string | null {
  const answer = lines.find((line) => line.role === "assistant" && line.turnId !== null);
  if (answer?.senderId) return answer.senderId;
  const senders = new Set(
    lines.filter((line) => line.role === "assistant").map((line) => line.senderId),
  );
  const [only] = senders;
  return senders.size === 1 && only ? only : null;
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        windowHours: {
          type: "number",
          description: "How many hours back to fetch chats (default: 24)",
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const windowHours = (args.windowHours as number | undefined) ?? 24;
      const cutoffSeconds = Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);

      log.info("fetching account chats", { windowHours, cutoffSeconds });

      // Every conversation on one of Rome's accounts. A channel's id is the
      // connection kind only for that kind's first account, so the kind and
      // platform come from `channels`, and from the id only when its record is
      // gone. 'notification' is a line that passed outside a turn: someone the
      // agent did not answer, or Rome sending untied to one. Rome's own lines
      // are told apart by the rule of `agentMessageOutbound` in
      // packages/core/src/channels/messages-agent.ts. Lines stored in the same
      // second keep the order they were stored in.
      let rows: MessageRow[];
      const reads = chatReadsOf(appContext);
      try {
        if (reads) {
          // Through Chats, which reads every line Rome sent as `assistant`.
          const since = new Date(cutoffSeconds * 1000);
          rows = [];
          for (const chat of await reads.recentChats({
            since,
            where: { accountKinds: ACCOUNT_KINDS },
          })) {
            const lines = await reads.transcript(chat.sessionId, { since });
            const ownAccount = accountOf(lines);
            for (const line of lines.slice(-MESSAGES_PER_CHAT)) {
              // A chat can hold several of Rome's accounts, each with its own
              // agent, so only this session's account's lines are its agent's.
              const other =
                line.role === "assistant" && line.senderId !== null && line.senderId !== ownAccount
                  ? line.senderId
                  : undefined;
              rows.push({
                session_id: chat.sessionId,
                session_name: chat.name,
                thread_name: chat.threadName,
                channel: chat.channel?.name ?? chat.chat.platform,
                connection_kind: chat.channel?.kind ?? chat.chat.platform,
                platform: chat.chat.platform,
                role: line.role,
                agent_name: chat.agentName,
                outbound: line.role === "assistant" ? 1 : 0,
                ...(other ? { other_account: other } : {}),
                sender_name: line.senderName,
                sender_id: line.senderId,
                content: line.content,
                created_at: Math.floor(line.createdAt.getTime() / 1000),
                chat_total: lines.length,
              });
            }
          }
          // Each account's chats together, as the formatting groups them.
          rows.sort((a, b) => a.channel.localeCompare(b.channel));
        } else
          rows = appContext.db.connection.all(
            sql`
            SELECT * FROM (
              SELECT m.session_id, s.name AS session_name, s.source_thread_name AS thread_name,
                s.source_channel AS channel,
                coalesce(c.connection_kind, s.source_channel) AS connection_kind,
                coalesce(c.platform, s.source_channel) AS platform, m.role,
                ${ANSWERING_AGENT} AS agent_name,
                CASE
                  WHEN m.role = 'assistant' THEN 1
                  WHEN m.role = 'notification' AND m.sender_id = 'rome' THEN 1
                  ELSE 0
                END AS outbound,
                m.sender_name, m.sender_id, m.content, m.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY m.session_id ORDER BY m.created_at DESC, m.rowid DESC
                ) AS newest,
                m.rowid AS stored,
                COUNT(*) OVER (PARTITION BY m.session_id) AS chat_total
              FROM rome_agent_messages m
              JOIN rome_sessions s ON s.id = m.session_id
              LEFT JOIN channels c ON c.id = s.source_channel
              WHERE m.created_at >= ${cutoffSeconds}
                AND m.role IN ('user', 'assistant', 'notification')
                AND ${onRomeAccount}
            )
            WHERE newest <= ${MESSAGES_PER_CHAT}
            ORDER BY channel, session_id, created_at ASC, stored ASC
          `,
          ) as MessageRow[];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("failed to query account chats", { error: message });
        return { status: "error", error: `Failed to query account chats: ${message}` };
      }

      const chats = formatChats(rows);
      log.info("fetched account chats", { count: rows.length, shown: chats.shown, windowHours });

      const windowStart = new Date(cutoffSeconds * 1000).toISOString();
      const windowEnd = new Date().toISOString();
      const header = `## Chats on Rome's accounts (${windowStart} → ${windowEnd})\n\n`;

      return {
        status: "ok",
        data: {
          messageCount: chats.shown,
          windowHours,
          content: header + chats.content,
        },
      };
    },
  };
}
