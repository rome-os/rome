// Searches the guardian's requests across the dashboard's past chats, so a
// dream can tell a one-off task from one the guardian keeps asking for.
import { sql } from "drizzle-orm";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { guardianOnlyChat, inDashboardChat } from "../../lib/chat-activity.js";
import { extractText } from "../../lib/message-text.js";

const log = createAppLogger("search_chats");

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Matching requests read before ranking, newest first. A query word common
// enough to hit more than this is too broad to rank on.
const MAX_ROWS = 2000;
const QUOTES_PER_CHAT = 3;
const CHARS_PER_QUOTE = 500;
const CHARS_PER_OPENING = 300;

interface RequestRow {
  session_id: string;
  session_name: string;
  content: string;
  created_at: number;
}

interface ChatHit {
  sessionId: string;
  name: string;
  /** Distinct query words in its best-matching request. */
  score: number;
  /** Matching requests, newest first. */
  requests: Array<{ text: string; createdAt: number }>;
  firstAt: number;
  lastAt: number;
  /** The chat's first message of any kind, which can predate every match. */
  startedAt: number;
}

/** Lower-cased distinct words of a query, with surrounding quotes and punctuation stripped. */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((word) => word.replace(/^["'`(]+|["'`).!?:]+$/g, ""))
    .filter((word) => word.length >= 2);
  return [...new Set(words)];
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Groups matching requests by chat, best match first. */
function rankChats(rows: RequestRow[], words: string[]): ChatHit[] {
  const chats = new Map<string, ChatHit>();
  for (const row of rows) {
    const text = extractText(row.content);
    // The SQL filter also matches inside stored JSON; count only the words in
    // what the guardian wrote.
    const lower = text.toLowerCase();
    const score = words.filter((word) => lower.includes(word)).length;
    if (score === 0) continue;
    const chat = chats.get(row.session_id) ?? {
      sessionId: row.session_id,
      name: row.session_name,
      score: 0,
      requests: [],
      firstAt: row.created_at,
      lastAt: row.created_at,
      startedAt: row.created_at,
    };
    chats.set(row.session_id, chat);
    chat.score = Math.max(chat.score, score);
    chat.requests.push({ text, createdAt: row.created_at });
    chat.firstAt = Math.min(chat.firstAt, row.created_at);
    chat.lastAt = Math.max(chat.lastAt, row.created_at);
  }
  return [...chats.values()].sort(
    (a, b) => b.score - a.score || b.requests.length - a.requests.length || b.lastAt - a.lastAt,
  );
}

function formatHit(chat: ChatHit, wordCount: number, now: number): string {
  // Wide enough for get_webchat_conversations to return the whole chat, from
  // the request that started it, not just from the first match.
  const windowHours = Math.ceil((now - chat.startedAt) / 3600) + 1;
  const quotes = chat.requests
    .slice(0, QUOTES_PER_CHAT)
    .map((r) => `- ${isoDate(r.createdAt)}: ${clip(r.text, CHARS_PER_QUOTE)}`);
  if (chat.requests.length > QUOTES_PER_CHAT) {
    quotes.push(`- …and ${chat.requests.length - QUOTES_PER_CHAT} more matching requests`);
  }
  return [
    `### ${chat.name}`,
    `${isoDate(chat.firstAt)} to ${isoDate(chat.lastAt)}, ${chat.score} of ${wordCount} words in one request`,
    `Open: get_webchat_conversations { "sessionId": ${JSON.stringify(chat.sessionId)}, "windowHours": ${windowHours} }`,
    "",
    ...quotes,
  ].join("\n");
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { connection } = deps.appContext.db;

  /**
   * The opening request of every chat active in the period, most recently
   * active first. A chat resumed in the period opens with its first request
   * ever, which can predate the period.
   */
  function listOpenings(cutoff: number, days: number, limit: number): ActionResult {
    const rows = connection.all(sql`
      SELECT session_id, session_name, content, created_at FROM (
        SELECT m.session_id, s.name AS session_name, m.content, m.created_at,
          ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at, m.id) AS n,
          MAX(m.created_at) OVER (PARTITION BY m.session_id) AS last_at
        FROM rome_agent_messages m
        JOIN rome_sessions s ON s.id = m.session_id
        WHERE m.role = 'user'
          AND ${inDashboardChat("s")}
          AND ${guardianOnlyChat("s")}
      )
      WHERE n = 1 AND last_at >= ${cutoff}
      ORDER BY last_at DESC
    `) as RequestRow[];
    const now = Math.floor(Date.now() / 1000);
    const lines = rows
      .slice(0, limit)
      .map(
        (row) =>
          `- ${isoDate(row.created_at)} **${row.session_name}** (open: \`{ "sessionId": ${JSON.stringify(row.session_id)}, "windowHours": ${Math.ceil((now - row.created_at) / 3600) + 1} }\`): ${clip(extractText(row.content), CHARS_PER_OPENING)}`,
      );
    log.info("listed chat openings", { days, chats: rows.length });
    const header = `## Opening request of each dashboard chat, last ${days} days`;
    return {
      status: "ok",
      data: {
        chatCount: rows.length,
        returned: lines.length,
        content:
          lines.length > 0
            ? `${header}\n\nMost recently active first. Open one by passing its arguments to get_webchat_conversations.\n\n${lines.join("\n")}`
            : `${header}\n\n(No chat with a guardian request in the period.)`,
      },
    };
  }

  /** Chats whose guardian requests contain the most query words. */
  function search(words: string[], cutoff: number, days: number, limit: number): ActionResult {
    const rows = connection.all(sql`
      SELECT m.session_id, s.name AS session_name, m.content, m.created_at
      FROM rome_agent_messages m
      JOIN rome_sessions s ON s.id = m.session_id
      WHERE m.role = 'user'
        AND m.created_at >= ${cutoff}
        AND ${inDashboardChat("s")}
        AND ${guardianOnlyChat("s")}
        AND (${sql.join(
          words.map((word) => sql`lower(m.content) LIKE ${likePattern(word)} ESCAPE '\\'`),
          sql` OR `,
        )})
      ORDER BY m.created_at DESC
      LIMIT ${MAX_ROWS}
    `) as RequestRow[];
    const ranked = rankChats(rows, words);
    const top = ranked.slice(0, limit);
    if (top.length > 0) {
      const starts = connection.all(sql`
        SELECT session_id, MIN(created_at) AS started_at FROM rome_agent_messages
        WHERE session_id IN (${sql.join(
          top.map((chat) => sql`${chat.sessionId}`),
          sql`, `,
        )})
        GROUP BY session_id
      `) as Array<{ session_id: string; started_at: number }>;
      for (const { session_id, started_at } of starts) {
        const chat = top.find((c) => c.sessionId === session_id);
        if (chat) chat.startedAt = Math.min(chat.startedAt, started_at);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const sections = top.map((chat) => formatHit(chat, words.length, now));
    log.info("searched chats", { days, words: words.length, chats: ranked.length });
    const header = `## Dashboard chats matching ${words.map((w) => `\`${w}\``).join(", ")}, last ${days} days`;
    return {
      status: "ok",
      data: {
        chatCount: ranked.length,
        returned: sections.length,
        content:
          sections.length > 0
            ? `${header}\n\n${sections.join("\n\n---\n\n")}`
            : `${header}\n\n(No guardian request matches.)`,
      },
    };
  }

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words to look for in the guardian's requests, such as `invoice pdf rename`. A chat ranks higher the more of the words one request contains. Omit to list the opening request of every chat in the period.",
        },
        days: {
          type: "number",
          description: `How many days back to search (default: ${DEFAULT_DAYS}, max: ${MAX_DAYS})`,
        },
        limit: {
          type: "number",
          description: `How many chats to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const days = Math.min(Math.max(Number(args.days) || DEFAULT_DAYS, 1), MAX_DAYS);
      const limit = Math.min(
        Math.max(Math.floor(Number(args.limit) || DEFAULT_LIMIT), 1),
        MAX_LIMIT,
      );
      const query = typeof args.query === "string" ? args.query : "";
      const words = queryWords(query);
      if (query.trim() && words.length === 0) {
        return { status: "error", error: "query has no word of two or more characters" };
      }
      const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

      try {
        return words.length > 0
          ? search(words, cutoff, days, limit)
          : listOpenings(cutoff, days, limit);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error("failed to search chats", { error });
        return { status: "error", error: `Failed to search chats: ${error}` };
      }
    },
  };
}
