// Tells the Concierge, as one ordinary automated message in the guardian's main
// chat, which sessions' last turn did not finish, and lets it decide what to
// continue. Contract: docs/concepts/sessions.md.

import { sql } from "drizzle-orm";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { type ConciergeOwner, GUARDIAN_OWNER } from "./owner.js";

const log = createLogger("interrupted-notice");
/** The notice carries it, so a restart that cuts off the Concierge's turn on it sends no second notice. */
export const RESTART_MARKER = "<restart_recovery>";
const DAY_SECONDS = 24 * 60 * 60;
const clean = (value: unknown) =>
  String(value ?? "")
    .replace(/[<>\s]+/g, " ")
    .trim();
const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/** The notice, or null when no guardian session's newest turn ended in an error or was abandoned within a day. */
export function noticeText(db: DrizzleDb, headline: string, now = Date.now()): string | null {
  const rows = db.all<Record<string, string | number | null>>(sql`
    SELECT s.id, s.type, s.name, s.agent_name, s.parent_session_id, s.chat_platform,
      t.created_at AS started,
      (SELECT substr(json_extract(e.content, '$.error'), 1, 120) FROM rome_agent_trace_blocks e
        WHERE e.message_id = t.id AND json_extract(e.content, '$.type') = 'error'
        ORDER BY e.seq DESC LIMIT 1) AS error
    FROM rome_sessions s
    JOIN rome_agent_messages t ON t.id = (SELECT n.id FROM rome_agent_messages n
      WHERE n.session_id = s.id AND n.role = 'trace' ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1)
    WHERE s.activity_at >= ${Math.floor(now / 1000) - DAY_SECONDS}
      AND s.archived_at IS NULL
      AND (s.owner_key IS NULL OR s.owner_key = ${GUARDIAN_OWNER})
      AND (SELECT json_extract(b.content, '$.status') FROM rome_agent_trace_blocks b
        WHERE b.message_id = t.id AND json_extract(b.content, '$.type') IN ('turn_start', 'turn_end')
        ORDER BY b.seq DESC LIMIT 1) IN ('error', 'stopped')
    ORDER BY t.created_at LIMIT 30`);
  if (rows.length === 0) return null;
  const lines = rows.map((r) =>
    [
      `- ${r.type} "${clean(r.name)}" · ${r.agent_name ?? "main"} · id ${r.id}`,
      r.parent_session_id ? `parent ${r.parent_session_id}` : "",
      r.chat_platform && r.chat_platform !== "webchat" ? clean(r.chat_platform) : "",
      `started ${minute(Number(r.started) * 1000)}`,
      r.error ? `error: ${clean(r.error)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
  return [
    `${RESTART_MARKER}Automated message from Rome: ${headline}. These sessions' last turn did not finish in the last day:`,
    ...lines,
    "For each one, decide whether to continue it. Read it first (chat_read or system:fetch_channel_history).",
    "Before redoing anything outside Rome (merge, deploy, send, post, pay), check whether it already happened; if unsure, ask the guardian.",
    "Continue your own task chats with chat_send and other chats with system:send_user_message. Rerun app work through a task chat only if still needed.",
    "Do not continue other-channel chats, subagents (continue the parent), or a chat a restart has already cut twice.",
    "Tell the guardian only what failed or needs their decision; otherwise stay silent.",
    "</restart_recovery>",
  ].join("\n");
}

/** Sends the notice, when there is one, into the guardian's main Concierge chat. A failure is logged, never thrown. */
export function conciergeNotifier(deps: {
  db: DrizzleDb;
  concierge: { ensureChatId(owner: ConciergeOwner): Promise<string> };
  actions: Pick<ActionEngine, "run">;
}): (headline: string) => Promise<void> {
  return async (headline) => {
    try {
      const text = noticeText(deps.db, headline);
      if (!text) return;
      const sessionId = await deps.concierge.ensureChatId(GUARDIAN_OWNER);
      const sent = await deps.actions.run(
        "system:send_user_message",
        { sessionId, text },
        { initiator: "system:restart-recovery" },
      );
      if (sent.status === "error") throw new Error(String(sent.error));
    } catch (error) {
      log.warn("could not tell the Concierge about unfinished work", { error: String(error) });
    }
  };
}

/** Call once after startup with the turns this boot's sweep ended. Silent when it ended none, or ended the Concierge's own notice turn. */
export async function announceInterrupted(
  ended: readonly { prompt: string }[],
  notify: (headline: string) => Promise<void>,
): Promise<void> {
  if (ended.length === 0 || ended.some((turn) => turn.prompt.includes(RESTART_MARKER))) return;
  await notify(`Rome restarted at ${minute(Date.now())}`);
}
