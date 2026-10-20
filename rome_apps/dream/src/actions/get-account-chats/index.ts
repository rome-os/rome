// Recent chats on every one of Rome's accounts, read from Rome's own
// transcript. Accounts and channels: docs/architecture/channels.md.
import { sql } from "drizzle-orm";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { onRomeAccount } from "../../lib/chat-activity.js";
import { extractText } from "../../lib/message-text.js";

const log = createAppLogger("get_account_chats");

// What is kept, so busy chats cannot crowd the other sources out of Dream's
// context: the newest lines per chat, the characters per line, and the
// characters across every chat, spent on the most recently active chats first.
const MESSAGES_PER_CHAT = 50;
const CHARS_PER_MESSAGE = 1000;
const CHARS_IN_ALL = 60_000;

interface MessageRow {
  session_id: string;
  session_name: string;
  thread_name: string | null;
  channel: string;
  service: string;
  platform: string;
  role: string;
  outbound: number;
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  created_at: number;
  /** Lines the chat holds in the window, kept or not. */
  chat_total: number;
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
  const service = row.service !== platform ? ` (${row.service})` : "";
  return `### ${name} account \`${row.channel}\`${service}`;
}

function speakerOf(row: MessageRow): string {
  if (row.outbound) return "Agent";
  return row.sender_name || row.sender_id || "Unknown";
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

function formatChats(rows: MessageRow[]): string {
  if (rows.length === 0) {
    return "(No chats on Rome's accounts in the requested window.)";
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
  let budget = CHARS_IN_ALL;
  let leftOut = 0;
  for (const chat of byRecent) {
    const lines = chat.messages.map(formatLine).filter(Boolean).join("\n\n");
    if (!lines) continue;
    const left = chat.total - chat.messages.length;
    const note = left > 0 ? `(${left} earlier messages left out)\n\n` : "";
    const text = `#### Chat: ${chat.name}\n\n${note}${lines}`;
    if (text.length > budget) {
      leftOut += 1;
      continue;
    }
    budget -= text.length;
    kept.set(chat.account, [...(kept.get(chat.account) ?? []), text]);
  }

  const parts = [...kept].map(
    ([account, texts]) => `${headings.get(account)}\n\n${texts.join("\n\n")}`,
  );
  if (leftOut > 0) parts.push(`(${leftOut} less recent chats left out to keep this short.)`);
  return parts.length > 0 ? parts.join("\n\n---\n\n") : "(No readable messages found.)";
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
      // service name only for its service's first account, so the service and
      // platform come from `channels`, and from the id only when its record is
      // gone. 'notification' is a line that passed outside a turn: someone the
      // agent did not answer, or Rome sending untied to one. Rome's own lines
      // are told apart as `agentMessageOutbound` in
      // packages/core/src/channels/messages-agent.ts does.
      let rows: MessageRow[];
      try {
        rows = appContext.db.connection.all(
          sql`
            SELECT * FROM (
              SELECT m.session_id, s.name AS session_name, s.source_thread_name AS thread_name,
                s.source_channel AS channel,
                coalesce(c.service, s.source_channel) AS service,
                coalesce(c.platform, s.source_channel) AS platform, m.role,
                CASE
                  WHEN m.role = 'assistant' THEN 1
                  WHEN m.role = 'notification' AND m.sender_id = 'rome' THEN 1
                  ELSE 0
                END AS outbound,
                m.sender_name, m.sender_id, m.content, m.created_at,
                ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at DESC) AS newest,
                COUNT(*) OVER (PARTITION BY m.session_id) AS chat_total
              FROM rome_agent_messages m
              JOIN rome_sessions s ON s.id = m.session_id
              LEFT JOIN channels c ON c.id = s.source_channel
              WHERE m.created_at >= ${cutoffSeconds}
                AND m.role IN ('user', 'assistant', 'notification')
                AND ${onRomeAccount}
            )
            WHERE newest <= ${MESSAGES_PER_CHAT}
            ORDER BY channel, session_id, created_at ASC
          `,
        ) as MessageRow[];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("failed to query account chats", { error: message });
        return { status: "error", error: `Failed to query account chats: ${message}` };
      }

      log.info("fetched account chats", { count: rows.length, windowHours });

      const windowStart = new Date(cutoffSeconds * 1000).toISOString();
      const windowEnd = new Date().toISOString();
      const header = `## Chats on Rome's accounts (${windowStart} → ${windowEnd})\n\n`;

      return {
        status: "ok",
        data: {
          messageCount: rows.length,
          windowHours,
          content: header + formatChats(rows),
        },
      };
    },
  };
}
