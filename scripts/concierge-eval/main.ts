// pnpm concierge:eval — measures how much the Concierge says against a fixed
// owner script, each round from the same frozen snapshot of a dev stack.
// docs/concierge-eval.md

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Api, DEV_JWT_SECRET } from "./api.js";
import { drive } from "./drive.js";
import { type MessageRow, type TurnRow, chatMetrics, isOwnerMessage, kindOf } from "./metrics.js";
import {
  type Checks,
  type RoundResult,
  type ScenarioResult,
  aggregateMarkdown,
  compareMarkdown,
  roundMarkdown,
} from "./report.js";
import { SCENARIOS, SCENARIOS_VERSION, type Scenario } from "./scenarios.js";
import { Stack } from "./stack.js";

const USAGE = `pnpm concierge:eval --snapshot [--name <snapshot>]
pnpm concierge:eval --label <name> [--rounds N] [--compare <label>] [--only id,id] [--name <snapshot>]
pnpm concierge:eval --report <label> [--compare <label>]

Options:
  --container <name>   backend container (default rome-rome-1)
  --base-url <url>     dashboard origin (default $ROME_URL or http://rome.rome.localhost:3000)
  --user <id>          guardian user id (default dev)
  --out <dir>          results folder (default .concierge-eval)
  --settle <s>         quiet seconds that end a step (default 45)
  --timeout <min>      longest a scenario may take (default 25)
  --serial             run a round's scenarios one at a time
  --no-restore         keep the stack as it is (debugging only: rounds are not comparable)`;

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "boolean" },
    name: { type: "string", default: "frozen" },
    label: { type: "string" },
    rounds: { type: "string", default: "1" },
    compare: { type: "string" },
    report: { type: "string" },
    only: { type: "string" },
    container: { type: "string", default: "rome-rome-1" },
    "base-url": {
      type: "string",
      default: process.env.ROME_URL ?? "http://rome.rome.localhost:3000",
    },
    user: { type: "string", default: "dev" },
    out: { type: "string", default: ".concierge-eval" },
    settle: { type: "string", default: "45" },
    timeout: { type: "string", default: "25" },
    serial: { type: "boolean" },
    "no-restore": { type: "boolean" },
    help: { type: "boolean" },
  },
});

const stack = new Stack({ container: args.container, baseUrl: args["base-url"] });
const PROMPT_SOURCES = [
  "packages/core/agents/concierge.yaml",
  "packages/core/src/concierge/conclusion.ts",
  "packages/core/src/concierge/task-events.ts",
  "packages/core/src/agent/domain/system-prompt.ts",
  "packages/core/src/agent/infrastructure/ask-user-tools.ts",
];

function promptHash(): string {
  // Hashed inside the container: what the stack runs, not this checkout.
  return execFileSync(
    "docker",
    [
      "exec",
      args.container,
      "sh",
      "-c",
      `cd /workspace && cat ${PROMPT_SOURCES.join(" ")} 2>/dev/null | sha256sum | cut -c1-64`,
    ],
    { encoding: "utf8" },
  ).trim();
}

function fileExists(name: string): boolean {
  try {
    execFileSync("docker", [
      "exec",
      args.container,
      "test",
      "-e",
      `/rome-home/.rome/default/projects/default/${name}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

interface ChatRows {
  messages: MessageRow[];
  turns: TurnRow[];
  speaking: { turn_id: string }[];
  models: { model: string }[];
  linked: { message_key: string }[];
  taskChats: { session_id: string }[];
  chatId: string;
}

function readChat(chatId: string): ChatRows {
  const [messages, turns, speaking, models, linked, taskChats] = stack.query([
    {
      sql: `SELECT m.key, m.sender_agent, m.text, m.parts, m.said_at, m.chat_thread_id
            FROM chat_messages m JOIN chats c ON c.id = m.chat_id
            WHERE c.platform = 'webchat' AND c.key = ? ORDER BY m.said_at, m.id`,
      params: [chatId],
    },
    {
      sql: `SELECT turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
            FROM rome_agent_messages WHERE role = 'trace' AND session_id = ? AND turn_id IS NOT NULL`,
      params: [chatId],
    },
    {
      sql: `SELECT DISTINCT atm.turn_id FROM agent_turn_messages atm
            WHERE atm.session_id = ? AND atm.role = 'answer' AND atm.turn_id IS NOT NULL`,
      params: [chatId],
    },
    {
      sql: `SELECT DISTINCT coalesce(provider, '?') || '/' || coalesce(model, '?') AS model
            FROM sessions WHERE chat_id = ?`,
      params: [chatId],
    },
    { sql: "SELECT message_key FROM concierge_message_tasks WHERE chat_id = ?", params: [chatId] },
    {
      sql: "SELECT session_id FROM concierge_tasks WHERE chat_id = ? AND session_id IS NOT NULL",
      params: [chatId],
    },
  ]);
  return {
    messages: messages as unknown as MessageRow[],
    turns: turns as unknown as TurnRow[],
    speaking: speaking as unknown as { turn_id: string }[],
    models: models as unknown as { model: string }[],
    linked: linked as unknown as { message_key: string }[],
    taskChats: taskChats as unknown as { session_id: string }[],
    chatId,
  };
}

/** The task chats that asked the owner something: a question card or an approval. */
function decidingTaskChats(sessionIds: string[]): Set<string> {
  if (!sessionIds.length) return new Set();
  const marks = sessionIds.map(() => "?").join(",");
  const [questions, approvals] = stack.query<{ id: string }>([
    {
      sql: `SELECT DISTINCT c.key AS id FROM chat_messages m JOIN chats c ON c.id = m.chat_id
            WHERE c.platform = 'webchat' AND c.key IN (${marks}) AND m.parts LIKE '%"pending_interaction"%'`,
      params: sessionIds,
    },
    {
      sql: `SELECT DISTINCT json_extract(payload, '$.channelContext.threadId') AS id FROM approvals
            WHERE type = 'action_execution' AND json_extract(payload, '$.channelContext.threadId') IN (${marks})`,
      params: sessionIds,
    },
  ]);
  return new Set([...(questions ?? []), ...(approvals ?? [])].map((r) => r.id));
}

/** The chat a scenario's rows were read from. */
const chatOf = (rows: ChatRows) => rows.chatId;

/**
 * The Concierge schedules of chat `chatId`'s tasks, and the routines its task
 * chats set up themselves, leaving out the checks they defer.
 */
function schedulesOf(chatId: string): { scheduled: number; taskChatRoutines: string[] } {
  const [scheduled, own] = stack.query<{ name: string }>([
    {
      sql: `SELECT r.name FROM routines r JOIN concierge_tasks t
              ON r.key = 'concierge-task-schedule:' || t.id
            WHERE t.chat_id = ?`,
      params: [chatId],
    },
    {
      sql: `SELECT r.name || ' (' || r.action_name || ')' AS name FROM routines r
            JOIN concierge_tasks t ON r.chat_id = t.session_id
            WHERE t.chat_id = ? AND r.action_name != 'resume_session'`,
      params: [chatId],
    },
  ]);
  return { scheduled: (scheduled ?? []).length, taskChatRoutines: (own ?? []).map((r) => r.name) };
}

function checksFor(
  scenario: Scenario,
  rows: ChatRows,
  tasks: { status: string; endReason: string | null; chat?: { id: string } | null }[],
  timedOut: boolean,
): Checks {
  const notes: string[] = [];
  const concierge = rows.messages.filter((m) => m.sender_agent);
  const checks: Checks = { nothingDropped: true, notes };

  if (scenario.expect.decision) {
    const deciding = decidingTaskChats(rows.taskChats.map((t) => t.session_id));
    const shown = new Set(
      concierge.flatMap((m) => {
        if (kindOf(m) === "own_ask") return ["own"];
        if (kindOf(m) !== "ask_card") return [];
        const part = (JSON.parse(m.parts) as { type: string; chatId?: string }[]).find(
          (p) => p.type === "task_chat",
        );
        return part?.chatId ? [part.chatId] : [];
      }),
    );
    const missed = [...deciding].filter((id) => !shown.has(id));
    checks.decisionAsked = (deciding.size > 0 || shown.has("own")) && missed.length === 0;
    if (deciding.size === 0 && !shown.has("own")) notes.push("no task asked the owner anything");
    if (missed.length) notes.push(`decision not shown for task chat ${missed.join(", ")}`);
  }

  if (scenario.expect.results) {
    const texts = concierge
      .filter((m) => ["say", "forward"].includes(kindOf(m)))
      .map((m) => m.text);
    const missing = scenario.expect.results.filter((r) => !texts.some((t) => r.test(t)));
    checks.resultReached = missing.length === 0;
    for (const r of missing) notes.push(`no result matched ${r}`);
  }

  const linked = new Set(rows.linked.map((l) => l.message_key));
  for (const owner of rows.messages.filter(isOwnerMessage)) {
    const heard = linked.has(owner.key) || concierge.some((m) => m.said_at >= owner.said_at);
    if (!heard) {
      checks.nothingDropped = false;
      notes.push(`owner message unanswered: ${owner.text.slice(0, 60)}`);
    }
  }
  const want = scenario.expect.endReason;
  // A scheduled task waits for its next run, as later.
  const settled = (t: { status: string; endReason: string | null }) =>
    (t.status === "ended" && t.endReason === want) ||
    (scenario.expect.schedule === true && t.status === "later");
  const wrong = tasks.filter((t) => !settled(t));
  if (want === "no_response" && !tasks.some((t) => t.endReason === "no_response")) {
    checks.nothingDropped = false;
    notes.push("no task ended for no response");
  } else if (want === "done" && wrong.length) {
    checks.nothingDropped = false;
    notes.push(
      `tasks not done: ${wrong.map((t) => `${t.status}/${t.endReason ?? "-"}`).join(", ")}`,
    );
  }
  if (scenario.expect.schedule) {
    const { scheduled, taskChatRoutines } = schedulesOf(chatOf(rows));
    checks.scheduled = scheduled > 0 && taskChatRoutines.length === 0;
    if (scheduled === 0) notes.push("no task of this chat has a schedule");
    for (const r of taskChatRoutines) notes.push(`a task chat set up routine ${r}`);
  }
  const file = scenario.expect.file;
  if (file && fileExists(file.name) !== file.exists) {
    checks.nothingDropped = false;
    notes.push(`${file.name} ${file.exists ? "missing" : "written"}`);
  }
  if (timedOut) {
    checks.nothingDropped = false;
    notes.push("timed out before the chat was quiet");
  }
  return checks;
}

function withFailure(checks: Checks, failure: string | null): Checks {
  if (failure) checks.notes.push(`the driver failed: ${failure}`);
  return checks;
}

async function runScenario(
  api: Api,
  label: string,
  round: number,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const started = Date.now();
  const chat = await api.createTopicChat(`eval ${label} r${round} ${scenario.id}`);
  const log = (line: string) => console.log(`[r${round} ${scenario.id}] ${line}`);
  log(`chat ${chat.id}`);
  let failure: string | null = null;
  const result = await drive(api, chat.id, scenario, {
    settleMs: Number(args.settle) * 1000,
    timeoutMs: Number(args.timeout) * 60_000,
    pollMs: 3000,
    log,
  }).catch((error: unknown) => {
    // One scenario's failure never ends the round: its checks fail instead.
    failure = error instanceof Error ? error.message : String(error);
    log(`failed: ${failure}`);
    return { outcomes: [], tasks: [], timedOut: true };
  });
  const rows = readChat(chat.id);
  const metrics = chatMetrics({
    messages: rows.messages,
    turns: rows.turns,
    speakingTurns: new Set(rows.speaking.map((s) => s.turn_id)),
    outcomes: result.outcomes,
    result: scenario.expect.results,
  });
  return {
    id: scenario.id,
    chatId: chat.id,
    metrics,
    checks: withFailure(checksFor(scenario, rows, result.tasks, result.timedOut), failure),
    tasks: result.tasks.map((t) => ({ title: t.title, status: t.status, endReason: t.endReason })),
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function scenarios(waitExpiry: number | null): Scenario[] {
  const only = args.only?.split(",").map((s) => s.trim());
  return SCENARIOS.filter((s) => !only || only.includes(s.id)).filter((s) => {
    if (s.expect.waitsForExpiry && (waitExpiry === null || waitExpiry > 10)) {
      console.warn(
        `skipping ${s.id}: set CONCIERGE_TASK_WAIT_EXPIRY_MINUTES=3 in the stack's root .env and recreate the rome container`,
      );
      return false;
    }
    return true;
  });
}

async function runRound(label: string, round: number): Promise<RoundResult> {
  if (!args["no-restore"]) {
    console.log(`round ${round}: restoring snapshot ${args.name}`);
    console.log(await stack.restore(args.name));
  }
  await stack.waitHealthy();
  const secret = stack.env("ROME_JWT_SECRET") ?? DEV_JWT_SECRET;
  const api = new Api(args["base-url"], args.user, secret);
  await api.checkGuardian();
  const waitExpiryRaw = stack.env("CONCIERGE_TASK_WAIT_EXPIRY_MINUTES");
  const waitExpiry = waitExpiryRaw ? Number(waitExpiryRaw) : null;
  const startedAt = new Date().toISOString();
  const list = scenarios(waitExpiry);
  const results: ScenarioResult[] = [];
  if (args.serial) {
    for (const s of list) results.push(await runScenario(api, label, round, s));
  } else {
    results.push(...(await Promise.all(list.map((s) => runScenario(api, label, round, s)))));
  }
  const models = [
    ...new Set(results.flatMap((r) => (readChat(r.chatId).models ?? []).map((m) => m.model))),
  ];
  return {
    label,
    round,
    startedAt,
    scenariosVersion: SCENARIOS_VERSION,
    models,
    promptHash: promptHash(),
    waitExpiryMinutes: waitExpiry,
    scenarios: results,
  };
}

/**
 * Judges again whether each expected result reached the owner, from the
 * messages a round kept, so two labels are always judged by the current
 * rules.
 */
function rejudge(round: RoundResult): RoundResult {
  for (const result of round.scenarios) {
    const expected = SCENARIOS.find((s) => s.id === result.id)?.expect.results;
    if (!expected) continue;
    const texts = result.metrics.messages
      .filter((m) => m.kind === "say" || m.kind === "forward")
      .map((m) => m.text);
    const missing = expected.filter((r) => !texts.some((t) => r.test(t)));
    result.checks.resultReached = missing.length === 0;
    result.checks.notes = [
      ...result.checks.notes.filter((n) => !n.startsWith("no result matched")),
      ...missing.map((r) => `no result matched ${r}`),
    ];
  }
  return round;
}

function readRounds(label: string): RoundResult[] {
  const dir = join(args.out, label);
  if (!existsSync(dir)) throw new Error(`no results for label ${label} in ${dir}`);
  return readdirSync(dir)
    .filter((f) => /^round-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((f) => rejudge(JSON.parse(readFileSync(join(dir, f), "utf8")) as RoundResult));
}

function writeSummary(label: string): void {
  const rounds = readRounds(label);
  const dir = join(args.out, label);
  writeFileSync(
    join(dir, "summary.md"),
    [aggregateMarkdown(label, rounds), ...rounds.map(roundMarkdown)].join("\n"),
  );
  console.log(aggregateMarkdown(label, rounds));
  if (args.compare) {
    const md = compareMarkdown(
      { label: args.compare, rounds: readRounds(args.compare) },
      { label, rounds },
    );
    const file = join(args.out, `compare-${args.compare}-vs-${label}.md`);
    writeFileSync(file, md);
    console.log(md);
    console.log(`wrote ${file}`);
  }
}

async function main(): Promise<void> {
  if (args.help) return void console.log(USAGE);
  if (args.snapshot) {
    console.log(`snapshot ${args.name}: stopping ${args.container} to copy its state`);
    console.log(await stack.snapshot(args.name));
    return;
  }
  if (args.report) return writeSummary(args.report);
  const label = args.label;
  if (!label || !/^[\w.-]+$/.test(label)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const dir = join(args.out, label);
  mkdirSync(dir, { recursive: true });
  const first = readRounds(label).length + 1;
  for (let round = first; round < first + Number(args.rounds); round++) {
    const result = await runRound(label, round);
    writeFileSync(join(dir, `round-${round}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(dir, `round-${round}.md`), roundMarkdown(result));
    console.log(roundMarkdown(result));
  }
  writeSummary(label);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
