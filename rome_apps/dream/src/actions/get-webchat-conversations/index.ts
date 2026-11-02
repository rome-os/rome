import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { guardianChats } from "../../lib/chat-lines.js";
import { extractText } from "../../lib/message-text.js";

const log = createAppLogger("get_webchat_conversations");

interface MessageRow {
  session_id: string;
  session_name: string;
  role: string;
  content: string;
  created_at: number;
}

function formatConversations(rows: MessageRow[]): string {
  if (rows.length === 0) {
    return "(No webchat conversations found in the requested window.)";
  }

  const sessions = new Map<string, { name: string; messages: MessageRow[] }>();
  for (const row of rows) {
    let session = sessions.get(row.session_id);
    if (!session) {
      session = { name: row.session_name, messages: [] };
      sessions.set(row.session_id, session);
    }
    session.messages.push(row);
  }

  const parts: string[] = [];
  for (const [, session] of sessions) {
    const lines = session.messages
      .map((m) => {
        const text = extractText(m.content);
        if (!text) return null;
        const speaker = m.role === "user" ? "Guardian" : "Agent";
        const time = new Date(m.created_at * 1000).toISOString();
        return `[${time}] **${speaker}**: ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");

    if (lines) {
      parts.push(`### Conversation: ${session.name}\n\n${lines}`);
    }
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
          description: "How many hours back to fetch conversations (default: 24)",
        },
        sessionId: {
          type: "string",
          description:
            "Scope results to a single session ID. When omitted, returns all sessions in the window.",
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const windowHours = (args.windowHours as number | undefined) ?? 24;
      const sessionId = args.sessionId as string | undefined;
      const cutoffSeconds = Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);

      log.info("fetching webchat conversations", { windowHours, cutoffSeconds, sessionId });

      let rows: MessageRow[] = [];
      try {
        const since = new Date(cutoffSeconds * 1000);
        for (const chat of await guardianChats(appContext, since, sessionId)) {
          for (const line of chat.lines) {
            if (line.createdAt < since || line.role === "notification") continue;
            rows.push({
              session_id: chat.sessionId,
              session_name: chat.name,
              role: line.role,
              content: line.content,
              created_at: Math.floor(line.createdAt.getTime() / 1000),
            });
          }
        }
      } catch (err) {
        log.error("failed to read webchat messages", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          status: "error",
          error: `Failed to read webchat messages: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      log.info("fetched webchat messages", { count: rows.length, windowHours });

      const windowStart = new Date(cutoffSeconds * 1000).toISOString();
      const windowEnd = new Date().toISOString();
      const header = `## Webchat Conversations (${windowStart} → ${windowEnd})\n\n`;
      const body = formatConversations(rows);

      return {
        status: "ok",
        data: {
          messageCount: rows.length,
          windowHours,
          content: header + body,
        },
      };
    },
  };
}
