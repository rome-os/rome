// Where a delegated task's time goes, from the stack's traces in rome-obs:
// the Concierge's turn up to `chat_start`, the task chat's start and cold
// open, its subagent calls, its own work, the wait until the Concierge hears
// of the result, and the Concierge's relay. docs/concierge-eval.md#baseline

import { createHash } from "node:crypto";

/** The tool a subagent is called by, as the agent context names it (agent/domain/subagent.ts). */
export const subagentToolName = (agentName: string) =>
  `sa_${createHash("sha256").update(agentName).digest("hex").slice(0, 16)}`;

/** One span, as the query returns it. Times are epoch ms. */
export interface SpanRow {
  trace: string;
  name: string;
  start: number;
  ms: number;
  agent: string;
  tool: string;
  outcome: string;
  subagent: string;
  model: string;
  /** The chat a span names, `webchat:<id>`; empty on spans that name none. */
  thread: string;
}

export interface SubagentCall {
  tool: string;
  /** The subagent's agent name and model, from its own spans in the trace. */
  agent: string | null;
  model: string | null;
  ms: number;
  /** Ran while another tool call of the same turn ran. */
  parallel: boolean;
}

export interface TaskPath {
  /** From the owner's send to `chat_start` returning. */
  toChatStartMs: number | null;
  /** From `chat_start` returning to the task chat's first turn starting. */
  taskStartGapMs: number | null;
  /** The task chat's session acquire and model session open, first turn. */
  taskOpenMs: number | null;
  /** The task chat's turns, summed. */
  taskTurnsMs: number | null;
  taskTurns: number;
  /** The model the task chat's own turns ran on. */
  taskModel: string | null;
  subagentCalls: SubagentCall[];
  /** Read, Grep and Glob calls of the task chat, which its memory checks use. */
  readCalls: number;
  /** Tool calls of the task chat by tool. */
  tools: Record<string, number>;
  /** From the task chat's last turn ending to the Concierge's relay turn starting. */
  relayWaitMs: number | null;
  /** The relay turn's first message, from its start. */
  relayFirstSayMs: number | null;
}

/** The SQL that reads the spans of the chats' turns, for rome-obs ClickHouse. */
export function spansSql(chatIds: string[], sinceIso: string): string {
  const keys = chatIds.map((id) => `'webchat:${id.replace(/'/g, "")}'`).join(",");
  const since = sinceIso.replace(/'/g, "").replace("T", " ").replace("Z", "");
  return `
WITH traces AS (
  SELECT DISTINCT TraceId FROM default.otel_traces
  WHERE Timestamp >= toDateTime64('${since}', 3) - INTERVAL 1 MINUTE
    AND SpanAttributes['channel.thread_key'] IN (${keys})
)
SELECT TraceId AS trace, SpanName AS name,
  toUnixTimestamp64Milli(Timestamp) AS start, intDiv(Duration, 1000000) AS ms,
  SpanAttributes['agent.name'] AS agent, SpanAttributes['tool.name'] AS tool,
  SpanAttributes['outcome'] AS outcome, SpanAttributes['is_subagent'] AS subagent,
  SpanAttributes['model.id'] AS model,
  SpanAttributes['channel.thread_key'] AS thread
FROM default.otel_traces
WHERE TraceId IN (SELECT TraceId FROM traces)
  AND (SpanName IN ('tool', 'session.acquire', 'model.session.open', 'model.turn')
    OR SpanName LIKE 'agent:%')
ORDER BY start
FORMAT JSONEachRow`;
}

const overlaps = (a: SpanRow, b: SpanRow) => a.start < b.start + b.ms && b.start < a.start + a.ms;

/**
 * The breakdown of one delegated task: `concierge` is the Concierge chat,
 * `task` its task chat, `sentAt` the owner's send, epoch ms.
 */
export function taskPath(
  rows: SpanRow[],
  concierge: string,
  task: string,
  sentAt: number,
): TaskPath {
  const conciergeKey = `webchat:${concierge}`;
  const taskKey = `webchat:${task}`;
  const tools = rows.filter((r) => r.name === "tool");
  const chatStart = tools.find((r) => r.thread === conciergeKey && r.tool === "chat_start");
  const chatStartEnd = chatStart ? chatStart.start + chatStart.ms : null;

  const taskAgentSpans = rows.filter((r) => r.name.startsWith("agent:") && r.thread === taskKey);
  const taskTraces = new Set(taskAgentSpans.map((r) => r.trace));
  const first = taskAgentSpans[0];
  const firstTrace = first?.trace;
  // The task's own session start: its acquire, which encloses a cold model
  // session open, so the open alone only when no acquire was traced.
  const own = (name: string) =>
    rows.filter(
      (r) =>
        r.trace === firstTrace &&
        r.name === name &&
        r.subagent !== "true" &&
        (r.agent === "" || r.agent === first?.agent),
    );
  const acquires = own("session.acquire");
  const opening = acquires.length ? acquires.slice(0, 1) : own("model.session.open").slice(0, 1);
  const inTask = rows.filter((r) => taskTraces.has(r.trace));
  const taskTools = inTask.filter((r) => r.name === "tool" && r.thread === taskKey);
  const toolCounts: Record<string, number> = {};
  for (const t of taskTools) toolCounts[t.tool] = (toolCounts[t.tool] ?? 0) + 1;

  // Each subagent call is matched to its own child turn: a subagent tool is
  // named for its agent (`subagentToolName`, sa_ and a hash of the name), so
  // two calls that overlap never share a child.
  const mainAgent = taskAgentSpans[0]?.agent;
  const children = inTask
    .filter((r) => r.name.startsWith("agent:") && r.agent !== "" && r.agent !== mainAgent)
    .sort((a, b) => a.start - b.start);
  const claimed = new Set<SpanRow>();
  const subagentCalls = taskTools
    .filter((t) => t.tool.startsWith("sa_"))
    .sort((a, b) => a.start - b.start)
    .map((call) => {
      const child = children.find(
        (r) =>
          !claimed.has(r) &&
          r.trace === call.trace &&
          subagentToolName(r.agent) === call.tool &&
          r.start >= call.start &&
          r.start <= call.start + call.ms,
      );
      if (child) claimed.add(child);
      // The child's model: its own model turn, which starts inside the child.
      const model = child
        ? inTask.find(
            (r) =>
              r.name === "model.turn" &&
              r.trace === child.trace &&
              r.agent === child.agent &&
              r.start >= child.start &&
              r.start <= child.start + child.ms,
          )?.model
        : undefined;
      return {
        tool: call.tool,
        agent: child?.agent ?? null,
        model: model ?? null,
        ms: call.ms,
        parallel: taskTools.some((o) => o !== call && o.trace === call.trace && overlaps(o, call)),
      };
    });

  const lastTaskEnd = taskAgentSpans.length
    ? Math.max(...taskAgentSpans.map((r) => r.start + r.ms))
    : null;
  const relay = rows.find(
    (r) =>
      r.name.startsWith("agent:") &&
      r.thread === conciergeKey &&
      lastTaskEnd !== null &&
      r.start >= lastTaskEnd - 1000,
  );
  const relaySay = relay
    ? tools.find(
        (t) =>
          t.trace === relay.trace &&
          (t.tool === "say" || t.tool === "card_forward") &&
          t.thread === conciergeKey,
      )
    : undefined;

  return {
    toChatStartMs: chatStartEnd === null ? null : chatStartEnd - sentAt,
    taskStartGapMs: chatStartEnd !== null && first ? first.start - chatStartEnd : null,
    taskOpenMs: opening.length ? opening.reduce((n, r) => n + r.ms, 0) : null,
    taskTurnsMs: taskAgentSpans.length ? taskAgentSpans.reduce((n, r) => n + r.ms, 0) : null,
    taskTurns: taskAgentSpans.length,
    taskModel:
      inTask.find((r) => r.name === "model.turn" && r.agent === taskAgentSpans[0]?.agent)?.model ??
      null,
    subagentCalls,
    readCalls: taskTools.filter((t) => ["Read", "Grep", "Glob"].includes(t.tool)).length,
    tools: toolCounts,
    relayWaitMs: relay && lastTaskEnd !== null ? relay.start - lastTaskEnd : null,
    relayFirstSayMs: relay && relaySay ? relaySay.start + relaySay.ms - relay.start : null,
  };
}

/** Reads the spans of the chats' turns from rome-obs. */
export async function readSpans(
  obsUrl: string,
  chatIds: string[],
  sinceIso: string,
): Promise<SpanRow[]> {
  const res = await fetch(`${obsUrl.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("default:").toString("base64")}` },
    body: spansSql(chatIds, sinceIso),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rome-obs answered ${res.status}: ${text.slice(0, 200)}`);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return {
        ...(row as unknown as SpanRow),
        start: Number(row.start),
        ms: Number(row.ms),
      };
    });
}
