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

interface MessageRow {
  session_id: string;
  session_name: string;
  thread_name: string | null;
  channel: string;
  service: string | null;
  platform: string | null;
  role: string;
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  created_at: number;
}

interface Chat {
  name: string;
  messages: MessageRow[];
}

interface Account {
  heading: string;
  chats: Map<string, Chat>;
}

/**
 * The heading an account is listed under. A channel row that is gone leaves
 * only the channel id, which then stands in for the platform too.
 */
function accountHeading(row: MessageRow): string {
  const platform = row.platform ?? row.channel;
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  const service = row.service && row.service !== platform ? ` (${row.service})` : "";
  return `### ${name} account \`${row.channel}\`${service}`;
}

function speakerOf(row: MessageRow): string {
  if (row.role === "assistant") return "Agent";
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
      chat = { name: row.thread_name || row.session_name, messages: [] };
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
          const text = extractText(m.content);
          if (!text) return null;
          const time = new Date(m.created_at * 1000).toISOString();
          return `[${time}] **${speakerOf(m)}**: ${text}`;
        })
        .filter(Boolean)
        .join("\n\n");
      if (lines) chats.push(`#### Chat: ${chat.name}\n\n${lines}`);
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

      // Every conversation on a channel other than webchat, as
      // `isChannelConversation` in packages/core/src/db/session-kind.ts reads
      // it, less a row that names no channel and so no account. A channel's id
      // is the service name only for its service's first account, so the
      // platform comes from `channels`, never from the id.
      let rows: MessageRow[];
      try {
        rows = appContext.db.connection.all(
          sql`
            SELECT m.session_id, s.name AS session_name, s.source_thread_name AS thread_name,
              s.source_channel AS channel, c.service, c.platform,
              m.role, m.sender_name, m.sender_id, m.content, m.created_at
            FROM rome_agent_messages m
            JOIN rome_sessions s ON s.id = m.session_id
            LEFT JOIN channels c ON c.id = s.source_channel
            WHERE m.created_at >= ${cutoffSeconds}
              AND m.role IN ('user', 'assistant')
              AND s.type = 'channel'
              AND s.source_channel IS NOT NULL
              AND s.source_channel <> 'webchat'
            ORDER BY s.source_channel, m.session_id, m.created_at ASC
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
