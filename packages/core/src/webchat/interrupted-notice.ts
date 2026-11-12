// What a Rome restart (or a cleared usage limit) cut off, told to the Concierge
// once, as an ordinary message in the guardian's main chat. The Concierge reads
// the list and decides what to continue. Contract: docs/concepts/sessions.md.

import { sql } from "drizzle-orm";
import { GUARDIAN_OWNER } from "./owner.js";
import { actorOfOwner } from "../access/owner-actor.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { ConciergeService } from "../concierge/service.js";
import type { DrizzleDb } from "../db/index.js";
import {
  actionExecutions,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
} from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { isConciergeChat, TASK_CHAT_TRIGGER_KIND } from "./privacy.js";
import { INTERRUPTED_TURN_ERROR, type InterruptedTurn } from "./repository.js";

const log = createLogger("interrupted-notice");
/** A turn whose prompt holds this is a notice turn: it is never listed again, so a crash loop cannot feed itself. */
export const RESTART_MARKER = "<restart_recovery>";
export const MAX_RESTART_INACTIVITY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 30;

/** Whether a turn's last timestamped activity is less than a day before `now`. */
export function isRecentActivity(lastActivityAt: number | null, now: number): boolean {
  return (
    typeof lastActivityAt === "number" &&
    Number.isFinite(lastActivityAt) &&
    Number.isFinite(now) &&
    lastActivityAt <= now &&
    now - lastActivityAt < MAX_RESTART_INACTIVITY_MS
  );
}

export interface InterruptedItem {
  sessionId: string;
  agent: string;
  title: string;
  kind: string;
  startedAt: number;
  lastActivityAt: number;
  lastStep: string | null;
  /** Why the Concierge must not continue this item, when it must not. */
  reportOnly: string | null;
  /** The turn was refused before it reached a model. */
  nothingDone: boolean;
}

type Row = {
  name: string;
  type: string;
  ownerKey: string | null;
  sessionTrigger: string | null;
  platform: string | null;
  archivedAt: number | null;
  parentId: string | null;
  startedAt: number;
  turnTrigger: string | null;
  action: string | null;
  args: string | null;
};

const oneLine = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, max);
};

/** The newest tool call of a turn, and whether its result was recorded. */
function lastStepOf(db: DrizzleDb, messageId: string): string | null {
  const blocks = db
    .all<{ content: string }>(sql`
      SELECT content FROM ${romeAgentTraceBlocks}
      WHERE message_id = ${messageId}
        AND json_extract(content, '$.type') IN ('tool_use', 'tool_result')
      ORDER BY seq DESC LIMIT 40`)
    .flatMap(({ content }) => {
      try {
        return [JSON.parse(content) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const use = blocks.find((block) => block.type === "tool_use");
  if (!use) return null;
  const answered = blocks.some((b) => b.type === "tool_result" && b.toolUseId === use.id);
  return `${oneLine(use.tool, 60)} ${oneLine(use.input, 80)}${answered ? "" : " (outcome unknown)"}`;
}

/**
 * How many of the session's turns just before this one, running back, ended
 * the same way (looks at two): cut off by a restart, or, for a usage limit, in
 * any error.
 */
function priorCuts(db: DrizzleDb, turn: InterruptedTurn, cause: "restart" | "usage_limit"): number {
  const sameEnd =
    cause === "restart"
      ? sql`json_extract(b.content, '$.type') = 'error'
          AND json_extract(b.content, '$.error') = ${INTERRUPTED_TURN_ERROR}`
      : sql`(json_extract(b.content, '$.type') = 'error'
          OR (json_extract(b.content, '$.type') = 'turn_end'
            AND json_extract(b.content, '$.status') = 'error'))`;
  const prior = db.all<{ cut: number }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM ${romeAgentTraceBlocks} b
        WHERE b.message_id = p.id AND ${sameEnd}
      ) AS cut
      FROM ${romeAgentMessages} p JOIN ${romeAgentMessages} t ON t.id = ${turn.messageId}
      WHERE p.session_id = ${turn.sessionId} AND p.role = 'trace' AND p.id <> t.id
        AND (p.created_at < t.created_at OR (p.created_at = t.created_at AND p.rowid < t.rowid))
      ORDER BY p.created_at DESC, p.rowid DESC LIMIT 2`);
  const run = prior.findIndex(({ cut }) => !cut);
  return run === -1 ? prior.length : run;
}

/**
 * The turns worth telling the Concierge about, as compact items. Left out in
 * code: a visitor's sessions, archived chats, subagent and fork sessions,
 * turns idle for a day, notice turns, and turns that ended the same way three
 * times running. A turn that did so twice running, and any turn on another
 * channel, is report only.
 */
export function describeInterrupted(
  db: DrizzleDb,
  repo: Pick<ChatsWebChatRepository, "getRestartLastActivityAt">,
  turns: readonly InterruptedTurn[],
  now = Date.now(),
  cause: "restart" | "usage_limit" = "restart",
): InterruptedItem[] {
  const items = new Map<string, InterruptedItem>();
  for (const turn of turns) {
    if (turn.prompt.includes(RESTART_MARKER)) continue;
    const row = db.get<Row>(sql`
      SELECT s.name, s.type, s.owner_key AS ownerKey, s.trigger_kind AS sessionTrigger,
        s.chat_platform AS platform, s.archived_at AS archivedAt, s.parent_session_id AS parentId,
        t.created_at AS startedAt, t.trigger_kind AS turnTrigger,
        a.action_name AS action, a.args AS args
      FROM ${romeSessions} s JOIN ${romeAgentMessages} t ON t.id = ${turn.messageId}
      LEFT JOIN ${actionExecutions} a ON a.id = s.root_action_execution_id
      WHERE s.id = ${turn.sessionId}`);
    if (!row || row.archivedAt != null) continue;
    if (row.ownerKey != null && row.ownerKey !== GUARDIAN_OWNER) continue;
    // The parent's chat shows each cut subagent call as failed.
    if (row.parentId || row.type === "subagent" || row.type === "fork") continue;
    const lastActivityAt = repo.getRestartLastActivityAt(turn);
    if (lastActivityAt === null || !isRecentActivity(lastActivityAt, now)) continue;
    const cuts = priorCuts(db, turn, cause);
    if (cuts >= 2) continue;
    const other = row.type === "channel" && row.platform !== "webchat";
    const chat = { id: turn.sessionId, agentName: turn.agentName };
    const kind =
      row.type === "action"
        ? `app run ${row.action ?? "?"} ${oneLine(row.args ?? "", 80)}`.trim()
        : other
          ? `${row.platform ?? "other"} channel chat`
          : row.sessionTrigger === TASK_CHAT_TRIGGER_KIND
            ? "Concierge task chat"
            : isConciergeChat(chat)
              ? "Concierge chat"
              : row.turnTrigger
                ? `wake-up turn (${row.turnTrigger}) in a chat`
                : "guardian chat";
    items.set(turn.sessionId, {
      sessionId: turn.sessionId,
      agent: turn.agentName,
      title: oneLine(row.name, 60),
      kind,
      startedAt: row.startedAt * 1000,
      lastActivityAt,
      lastStep: lastStepOf(db, turn.messageId),
      reportOnly: other
        ? "report only: another channel"
        : cuts > 0
          ? cause === "restart"
            ? "report only: cut by two restarts"
            : "report only: stopped by the limit twice"
          : null,
      nothingDone: false,
    });
  }
  return [...items.values()];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** The one message: a numbered list of items, then the rules for what to do with them. */
export function interruptedNoticeText(
  items: readonly InterruptedItem[],
  headline = `Rome restarted at ${iso(Date.now())} and cut off this work:`,
): string {
  const lines = items
    .slice(0, MAX_ITEMS)
    .map((item, i) =>
      [
        `${i + 1}. ${item.kind} "${item.title}" · ${item.agent} · id ${item.sessionId}`,
        `started ${iso(item.startedAt)} · last active ${iso(item.lastActivityAt)}`,
        item.lastStep ? `last step: ${item.lastStep}` : "",
        item.nothingDone ? "refused before it started: nothing was done" : "",
        item.reportOnly ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  if (items.length > MAX_ITEMS) lines.push(`…and ${items.length - MAX_ITEMS} more not listed.`);
  return [
    `${RESTART_MARKER}${headline}`,
    ...lines,
    "Read each item first (chat_read, or system:fetch_channel_history) and check the real state before redoing anything that changes the outside world (merge, deploy, send, post, pay); if you cannot confirm it, ask the guardian.",
    "Continue chats and task chats with system:send_user_message (that sessionId, plus one line on what is left). Rerun an app run through a task chat only if it is still needed.",
    'Only report other channels and anything marked "report only"; do not continue them.',
    "Tell the guardian in one message only what failed or needs their decision. Otherwise say nothing.",
    "</restart_recovery>",
  ].join("\n");
}

/** Sends a notice into the guardian's main Concierge chat, as an automated message acting for the guardian. */
export function conciergeNoticeSender(deps: {
  db: DrizzleDb;
  concierge: Pick<ConciergeService, "ensureChatId">;
  actions: Pick<ActionEngine, "run">;
}): (text: string) => Promise<void> {
  return async (text) => {
    const actor = await actorOfOwner(deps.db, GUARDIAN_OWNER);
    const result = await deps.actions.run(
      "system:send_user_message",
      { sessionId: await deps.concierge.ensureChatId(GUARDIAN_OWNER), text },
      { initiator: "system:restart-recovery", ...(actor ? { actor } : {}) },
    );
    if (result.status === "error") throw new Error(String(result.error));
  };
}

/** Call once after startup with this boot's cleanup results. Sends nothing when no turn is worth listing. */
export async function announceInterrupted(
  db: DrizzleDb,
  repo: Pick<ChatsWebChatRepository, "getRestartLastActivityAt">,
  ended: readonly InterruptedTurn[],
  send: (text: string) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  try {
    const items = describeInterrupted(db, repo, ended, now);
    if (items.length > 0) await send(interruptedNoticeText(items));
  } catch (error) {
    log.warn("could not tell the Concierge what the restart cut off", { error: String(error) });
  }
}
