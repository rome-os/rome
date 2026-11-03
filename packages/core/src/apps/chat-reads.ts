// What an app reads of the chats Rome's sessions stand in: the SDK's
// `ChatReads`, over Chats' relations and Agents' sessions. Vocabulary:
// docs/domains/chats.md and docs/domains/participation.md.
//
// Apps read these instead of querying Rome's tables, so a change to how
// Chats stores a line changes this file and not an app. Nothing hands them
// to apps yet: the Chats switch adds them to the app repositories and moves
// Dream, Briefing and Showcases onto them.

import type { ChatLine, ChatReads, RecentChat, SessionTrace } from "@rome-os/app-runtime/chats";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { platformOf } from "@rome/api-types/platform";
import { DASHBOARD_PLATFORM } from "../chats/send.js";
import { CHAT_LINES, CHATS } from "../chats/storage/lines-sql.js";
import type { DrizzleDb } from "../db/index.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { romeAgentMessages } from "../db/schema/system.js";
import type { ChatReadModel } from "../webchat/chat-read-model.js";

export interface AppChatReadsDeps {
  db: DrizzleDb;
  reads: Pick<ChatReadModel, "chatTranscript" | "sessionTranscript">;
  webchatRepo: Pick<WebChatRepository, "getTraceContents">;
}

export function appChatReads(deps: AppChatReadsDeps): ChatReads {
  return {
    recentChats: async ({ since, where }) => recentChats(deps.db, since, where),
    async transcript(sessionId, input = {}) {
      const transcript =
        (await deps.reads.chatTranscript(sessionId)) ??
        (await deps.reads.sessionTranscript(sessionId));
      const since = input.since?.getTime() ?? Number.NEGATIVE_INFINITY;
      return transcript.lines
        .filter((line) => line.createdAt.getTime() >= since)
        .map(
          (line): ChatLine => ({
            key: line.id,
            turnId: line.turnId,
            role: line.role,
            senderId: line.senderAccountId,
            senderName: line.senderName,
            content: line.content,
            createdAt: line.createdAt,
          }),
        );
    },
    traces: (sessionId) => traces(deps, sessionId),
  };
}

interface RecentRow {
  id: string;
  name: string;
  chat_id: number;
  platform: string;
  thread_name: string | null;
  owner_key: string | null;
  archived: number;
  channel: string | null;
  connection_kind: string | null;
  agent_name: string | null;
  project_name: string | null;
  project_path: string | null;
  created_at: number;
}

// The agent that answers in session `s`, by the rules in
// docs/architecture/channels.md#an-accounts-agent, over its channel `ch`: an
// account's agent answers its direct messages, and a group unless the chat is
// pinned to main. An account's main reads as null.
const ACCOUNT_AGENT = sql`CASE WHEN ch.agent IN ('main', 'core:main') THEN NULL ELSE ch.agent END`;
const ANSWERING_AGENT = sql`CASE WHEN ch.agent IS NOT NULL THEN CASE
    WHEN c.kind = 'dm' THEN ${ACCOUNT_AGENT}
    WHEN coalesce(json_type(s.channel_settings, '$.overrides.routing.agentName') = 'null', 0) = 1 THEN NULL
    WHEN coalesce(s.agent_name, 'main') IN ('main', 'core:main') THEN ${ACCOUNT_AGENT}
    ELSE s.agent_name END
  ELSE s.agent_name END`;

/**
 * Every session `scope` names, over the session `s`, its chat `c` and its
 * channel `ch`, where a line was said at or after `since` and since the
 * session came to stand there, the latest said first.
 */
function recentChats(
  db: DrizzleDb,
  since: Date,
  where: "dashboard" | { accountKinds: readonly string[] },
): RecentChat[] {
  const cutoff = Math.floor(since.getTime() / 1000);
  const scope: SQL =
    where === "dashboard"
      ? sql`c.platform = ${DASHBOARD_PLATFORM}`
      : // A platform carries other kinds of account too, such as the guardian's
        // own signed-in Telegram beside Rome's bot, and one kind can serve
        // several platforms, as Feishu serves Lark, so the channel's kind
        // decides. A session whose channel record is gone is read on its
        // platform.
        sql`(ch.connection_kind IN (SELECT value FROM json_each(${JSON.stringify(
          where.accountKinds,
        )})) OR (ch.connection_kind IS NULL AND c.platform IN (SELECT value FROM json_each(${JSON.stringify(
          [...new Set(where.accountKinds.map((kind) => platformOf(kind)))],
        )}))))`;
  const rows = db.all<RecentRow>(sql`
    SELECT s.id, s.name, s.chat_id, c.platform, s.source_thread_name AS thread_name,
      s.owner_key, s.archived_at IS NOT NULL AS archived,
      ch.id AS channel, ch.connection_kind, ${ANSWERING_AGENT} AS agent_name,
      s.project_name, s.project_path, s.created_at
    FROM rome_sessions s
    JOIN ${CHATS} c ON c.id = s.chat_id
    LEFT JOIN channels ch ON ch.platform = c.platform
      AND coalesce(ch.platform_account_id, ch.id) = s.account_id
    JOIN ${CHAT_LINES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
    WHERE ${scope} AND m.said_at >= max(${cutoff}, s.created_at)
    GROUP BY s.id
    ORDER BY max(m.said_at) DESC, max(m.seq) DESC
  `);
  return rows.map((row) => ({
    sessionId: row.id,
    chat: { platform: row.platform, id: row.chat_id },
    name: row.name,
    threadName: row.thread_name,
    ownerKey: row.owner_key ?? "guardian",
    archived: row.archived === 1,
    channel:
      row.channel === null || row.connection_kind === null
        ? null
        : { name: row.channel, kind: row.connection_kind },
    agentName: row.agent_name,
    projectName: row.project_name,
    projectPath: row.project_path,
    startedAt: new Date(row.created_at * 1000),
  }));
}

/** Session `sessionId`'s traces, oldest first, each with its blocks put back
 *  together and what its turn used. */
async function traces(deps: AppChatReadsDeps, sessionId: string): Promise<SessionTrace[]> {
  const stubs = deps.db
    .select({
      id: romeAgentMessages.id,
      turnId: romeAgentMessages.turnId,
      createdAt: romeAgentMessages.createdAt,
      inputTokens: romeAgentMessages.inputTokens,
      outputTokens: romeAgentMessages.outputTokens,
      cacheReadTokens: romeAgentMessages.cacheReadTokens,
      cacheWriteTokens: romeAgentMessages.cacheWriteTokens,
      costUsd: romeAgentMessages.costUsd,
    })
    .from(romeAgentMessages)
    .where(and(eq(romeAgentMessages.sessionId, sessionId), eq(romeAgentMessages.role, "trace")))
    .orderBy(asc(romeAgentMessages.createdAt), asc(romeAgentMessages.id))
    .all();
  if (stubs.length === 0) return [];
  const contents = new Map(
    (await deps.webchatRepo.getTraceContents(sessionId)).map((trace) => [trace.id, trace.content]),
  );
  return stubs.map((stub) => ({ ...stub, content: contents.get(stub.id) ?? "[]" }));
}
