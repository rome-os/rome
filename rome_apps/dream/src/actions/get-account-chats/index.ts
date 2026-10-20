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
import { extractText } from "../../lib/message-text.js";

const log = createAppLogger("get_account_chats");

// The services an agent can be linked to, as `LINKABLE_SERVICES` in
// @rome/api-types names them. Every other channel carries the guardian's own
// accounts (a linked WhatsApp, a WeChat login) or Rome's own traffic, and
// stays out of Dream.
const ACCOUNT_SERVICES = ["feishu", "telegram", "discord", "telegram_user"];

// The newest lines kept per chat, and the characters kept per line, so one
// busy group cannot crowd the other sources out of Dream's context.
const MESSAGES_PER_CHAT = 100;
const CHARS_PER_MESSAGE = 2000;

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
  name: string;
  total: number;
  messages: MessageRow[];
}

interface Account {
  heading: string;
  chats: Map<string, Chat>;
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

function formatChats(rows: MessageRow[]): string {
  if (rows.length === 0) {
    return "(No chats on Rome's accounts in the requested window.)";
  }

  const accounts = new Map<string, Account>();
  for (const row of rows) {
    let account = accounts.get(row.channel);
    if (!account) {
      account = { heading: accountHeading(row), chats: new Map() };
      accounts.set(row.channel, account);
    }
    let chat = account.chats.get(row.session_id);
    if (!chat) {
      chat = { name: row.thread_name || row.session_name, total: row.chat_total, messages: [] };
      account.chats.set(row.session_id, chat);
    }
    chat.messages.push(row);
  }

  const parts: string[] = [];
  for (const account of accounts.values()) {
    const chats: string[] = [];
    for (const chat of account.chats.values()) {
      const lines = chat.messages
        .map((m) => {
          const full = extractText(m.content);
          if (!full) return null;
          const text =
            full.length > CHARS_PER_MESSAGE ? `${full.slice(0, CHARS_PER_MESSAGE)}… (cut)` : full;
          const time = new Date(m.created_at * 1000).toISOString();
          return `[${time}] **${speakerOf(m)}**: ${text}`;
        })
        .filter(Boolean)
        .join("\n\n");
      const left = chat.total - chat.messages.length;
      const note = left > 0 ? `(${left} earlier messages left out)\n\n` : "";
      if (lines) chats.push(`#### Chat: ${chat.name}\n\n${note}${lines}`);
    }
    if (chats.length > 0) parts.push(`${account.heading}\n\n${chats.join("\n\n")}`);
  }

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

      // Every conversation on a channel of an account service. A channel's id
      // is the service name only for its service's first account, so the
      // service and platform come from `channels`, never from the id.
      // 'notification' is a line that passed outside a turn: someone the agent
      // did not answer, or Rome sending untied to one. Rome's own lines are
      // told apart as `agentMessageOutbound` in
      // packages/core/src/channels/messages-agent.ts does.
      const services = sql.join(
        ACCOUNT_SERVICES.map((service) => sql`${service}`),
        sql`, `,
      );
      let rows: MessageRow[];
      try {
        rows = appContext.db.connection.all(
          sql`
            SELECT * FROM (
              SELECT m.session_id, s.name AS session_name, s.source_thread_name AS thread_name,
                s.source_channel AS channel, c.service, c.platform, m.role,
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
              JOIN channels c ON c.id = s.source_channel
              WHERE m.created_at >= ${cutoffSeconds}
                AND m.role IN ('user', 'assistant', 'notification')
                AND s.type = 'channel'
                AND c.service IN (${services})
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
