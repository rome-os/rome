import { sql } from "drizzle-orm";
import { SESSION_LINES } from "./session-lines.js";
import type { RomeAppContext } from "@rome-os/app-runtime";
import { unwrap } from "./action-result.js";

// Personal context for the brief's "Try with Rome" section: what the guardian
// recently asked Rome in webchat, and their full Rome Cloud profile. Only the
// guardian's own chat words are read: a dashboard chat a visitor owns or wrote
// in is left out whole (the same rule Dream's chat-activity uses), as are
// archived chats and the agent's replies.

const WINDOW_HOURS = 48;
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 400;
const MAX_TOTAL_CHARS = 8000;

interface MessageRow {
  chat: string;
  content: string;
  created_at: number;
}

export interface GuardianContext {
  /** The guardian's recent webchat messages, grouped by chat, or null. */
  chats: string | null;
  /** What they shared with Rome Cloud about their work, or null. */
  profile: string | null;
}

export async function gatherGuardianContext(
  appContext: RomeAppContext,
  tz: string,
  now = Date.now(),
): Promise<GuardianContext> {
  return { chats: readRecentChats(appContext, tz, now), profile: await readProfile(appContext) };
}

function readRecentChats(appContext: RomeAppContext, tz: string, now: number): string | null {
  const cutoff = Math.floor((now - WINDOW_HOURS * 60 * 60 * 1000) / 1000);
  let rows: MessageRow[];
  try {
    rows = appContext.db.connection.all(sql`
      SELECT s.name AS chat, m.content, m.created_at
      FROM ${SESSION_LINES} m
      JOIN rome_sessions s ON s.id = m.session_id
      WHERE (s.type IN ('webchat', 'webchat_handoff')
          OR (s.type = 'channel' AND s.source_channel = 'webchat' AND s.source_thread_id = s.id))
        AND coalesce(s.owner_key, 'guardian') = 'guardian'
        AND s.id NOT IN (
          SELECT session_id FROM ${SESSION_LINES}
          WHERE role = 'user' AND coalesce(json_extract(actor, '$.kind'), 'guardian') <> 'guardian'
        )
        AND s.archived_at IS NULL
        AND m.role = 'user'
        AND m.created_at >= ${cutoff}
      ORDER BY m.created_at DESC
      LIMIT ${MAX_MESSAGES}
    `) as MessageRow[];
  } catch {
    return null;
  }

  // Keep the newest messages within the budget, then read them in order.
  const kept: MessageRow[] = [];
  let total = 0;
  for (const row of rows) {
    const text = messageText(row.content);
    if (!text) continue;
    const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
    if (total + clipped.length > MAX_TOTAL_CHARS) break;
    total += clipped.length;
    kept.push({ ...row, content: clipped });
  }
  if (kept.length === 0) return null;

  const byChat = new Map<string, string[]>();
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  for (const row of kept.reverse()) {
    const lines = byChat.get(row.chat) ?? [];
    lines.push(`- [${when.format(new Date(row.created_at * 1000))}] ${row.content}`);
    byChat.set(row.chat, lines);
  }
  return [...byChat].map(([chat, lines]) => `Chat "${chat}":\n${lines.join("\n")}`).join("\n\n");
}

/** Stored messages are a JSON list of parts; plain strings come from older rows. */
function messageText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.trim();
  }
  if (typeof parsed === "string") return parsed.trim();
  if (!Array.isArray(parsed)) return "";
  return parsed
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { type?: unknown; content?: unknown; text?: unknown } | null;
      if (p?.type !== "text") return "";
      if (typeof p.content === "string") return p.content;
      return typeof p.text === "string" ? p.text : "";
    })
    .join("\n")
    .trim();
}

function objectToMarkdown(value: unknown, indent = ""): string {
  if (value == null || (typeof value === "string" && !value.trim())) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const content = objectToMarkdown(item, `${indent}  `);
        if (!content) return "";
        if (typeof item !== "object") return `${indent}- ${content}`;
        const prefix = `${indent}  - `;
        const lines = content.split("\n");
        if (!Array.isArray(item) && lines.every((line) => line.startsWith(prefix))) {
          return `${indent}- ${lines.map((line) => line.slice(prefix.length)).join(" · ")}`;
        }
        return `${indent}- ${content.trimStart().slice(2)}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        const content = objectToMarkdown(item, `${indent}  `);
        if (!content) return "";
        const words = key
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
        const label = words.charAt(0).toUpperCase() + words.slice(1);
        const separator = typeof item === "object" ? "\n" : " ";
        return `${indent}- **${label}:**${separator}${content}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value).replace(/\n/g, `\n${indent}`);
}

async function readProfile(appContext: RomeAppContext): Promise<string | null> {
  try {
    const res = unwrap(await appContext.runAction("get_guardian_cloud_profile", {}));
    if (!res.ok || !res.data || typeof res.data !== "object" || Array.isArray(res.data))
      return null;
    return objectToMarkdown(res.data) || null;
  } catch {
    return null;
  }
}
