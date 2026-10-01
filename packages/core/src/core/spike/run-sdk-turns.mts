// SPIKE (t-8e1a6e90, do not merge): run the 9 cases of
// rome-work research/simplify-turns.md §4 against the real Claude Agent SDK.
//
//   cd packages/core
//   NODE_ENV=development npx tsx src/core/spike/run-sdk-turns.mts [case ...]
//
// Needs a logged-in Claude CLI (or ANTHROPIC_API_KEY). Writes a JSON result
// per case to $SPIKE_OUT (default /tmp/spike-sdk-turns).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { ModelSession } from "../agent-runner.js";
import { type Reply, SdkConversation } from "./sdk-conversation.js";

const OUT = process.env.SPIKE_OUT ?? "/tmp/spike-sdk-turns";
const WORKDIR = "/tmp/spike-sdk-turns-cwd";
mkdirSync(OUT, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Options {
  model?: string;
  maxTurns?: number;
  cards?: boolean;
  handback?: boolean;
}

async function open(opts: Options = {}): Promise<{ session: ModelSession; c: SdkConversation }> {
  let conversation: SdkConversation | undefined;
  const session = await new AnthropicProvider().openSession({
    model: opts.model ?? "claude-haiku-4-5",
    systemPrompt: "You are terse. Follow instructions exactly.",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    sessionId: crypto.randomUUID(),
    isNewSession: true,
    workingDir: WORKDIR,
    builtinTools: ["Bash"],
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    supportsInteractiveSurface: opts.cards ?? false,
    ...(opts.handback
      ? {
          handback: {
            schema: {
              type: "object",
              required: ["title", "items"],
              properties: {
                title: { type: "string" },
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
          executeSubmitOutput: async (payload: unknown) => {
            conversation?.recordSubmit(payload);
            return { ok: true, message: "Submission accepted. End your turn with DONE." };
          },
        }
      : {}),
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "x",
  } as never);
  conversation = new SdkConversation(session);
  return { session, c: conversation };
}

/** Wait until `check` holds, up to `ms`. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function settle(p: Promise<Reply>): Promise<Reply | { error: string }> {
  return p.catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
}

/** Kill every descendant process of this one (the Claude CLI). */
function killDescendants(): number[] {
  const kids = (pid: number): number[] => {
    let out = "";
    try {
      out = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" });
    } catch {
      return [];
    }
    const direct = out
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
    return direct.flatMap((child) => [child, ...kids(child)]);
  };
  const pids = kids(process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return pids;
}

type CaseResult = Record<string, unknown>;

function summarize(
  c: SdkConversation,
  replies: Record<string, Reply | { error: string }>,
): CaseResult {
  const short = (id: string) => id.slice(0, 8);
  return {
    turns: c.turns.map((t) => ({
      turn: short(t.turnId),
      startedBy: t.startedBy,
      answers: t.answers.map((id) => c.name(id)),
      subtype: t.subtype,
      ms: t.endedAt ? t.endedAt - t.startedAt : undefined,
      text: t.text.replace(/\s+/g, " ").slice(0, 80),
      tools: t.tools,
      cards: t.cards.map((card) => ({
        tool: card.tool,
        answering: card.answering.map((id) => c.name(id)),
      })),
      submits: t.submits.map((s) => ({
        answering: s.answering.map((id) => c.name(id)),
        payload: s.payload,
      })),
      terminal: t.terminal?.type,
    })),
    replies: Object.fromEntries(
      Object.entries(replies).map(([label, reply]) => [
        label,
        "error" in reply
          ? { error: reply.error }
          : {
              turn: short(reply.turnId),
              resultsNamingIt: reply.answeredBy.length,
              firstFrameMs: reply.firstFrameMs,
              totalMs: reply.totalMs,
              terminal: reply.terminal?.type,
              text: reply.text.replace(/\s+/g, " ").slice(0, 80),
            },
      ]),
    ),
    warnings: c.warnings,
    log: c.log,
  };
}

const cases: Record<string, () => Promise<CaseResult>> = {
  // 1. A background task finishing while idle becomes its own turn.
  async "1-background-idle"() {
    const { session, c } = await open();
    const a = await settle(
      c.send(
        "A",
        "Use the Bash tool with run_in_background=true to run `sleep 5; echo MARKER-41`. Do not wait for it. Reply with exactly DONE.",
      ),
    );
    await until(() => c.turns.some((t) => t.answers.length === 0 && t.endedAt), 45_000);
    const b = await settle(
      c.send(
        "B",
        "Without running any tool, what did the background command print? Answer in under 10 words.",
        { exclusive: true },
      ),
    );
    await session.close();
    return summarize(c, { A: a, B: b });
  },

  // 2. A follow-up sent while the final answer streams (the SDK carries it).
  async "2-late-followup"() {
    const { session, c } = await open();
    const a = settle(c.send("A", "Write the numbers 1 to 40, one per line, and nothing else."));
    await until(() => !!c.currentTurn, 30_000);
    await sleep(300);
    const s = settle(c.send("S", "Also end with the word BANANA."));
    const replies = { A: await a, S: await s };
    await session.close();
    return summarize(c, replies);
  },

  // 3. A follow-up sent during a tool call (the SDK folds it in).
  async "3-folded-followup"() {
    const { session, c } = await open();
    const a = settle(
      c.send(
        "A",
        "Run the Bash command `sleep 4; echo hi` (not in background), then reply with exactly OK.",
      ),
    );
    await until(() => (c.currentTurn?.tools.length ?? 0) > 0, 30_000);
    await sleep(1500);
    const s = settle(c.send("S", "Also end your reply with the word BANANA."));
    const replies = { A: await a, S: await s };
    await session.close();
    return summarize(c, replies);
  },

  // 4a. summon sent straight into a running background-task turn.
  async "4a-summon-into-task-turn"() {
    const { session, c } = await open();
    const a = await settle(
      c.send(
        "A",
        "Use Bash with run_in_background=true to run `sleep 4; echo DONE-77`. Do not wait. Reply with exactly READY. Later, when that background command finishes, first run `sleep 6` in the foreground with Bash, then say what it printed.",
      ),
    );
    const sawTaskTurn = await until(() => c.currentTurn?.answers.length === 0, 45_000);
    await until(() => (c.currentTurn?.tools.length ?? 0) > 0, 15_000);
    const q = await settle(c.send("Q", "Reply with exactly SUMMONED."));
    await until(() => c.idle, 30_000);
    await session.close();
    return { sawTaskTurn, ...summarize(c, { A: a, Q: q }) };
  },

  // 4b. summon with the idle gate: waits for the task turn to finish first.
  async "4b-summon-gated"() {
    const { session, c } = await open();
    const a = await settle(
      c.send(
        "A",
        "Use Bash with run_in_background=true to run `sleep 4; echo DONE-77`. Do not wait. Reply with exactly READY. Later, when that background command finishes, first run `sleep 6` in the foreground with Bash, then say what it printed.",
      ),
    );
    const sawTaskTurn = await until(() => c.currentTurn?.answers.length === 0, 45_000);
    const q = await settle(c.send("Q", "Reply with exactly SUMMONED.", { exclusive: true }));
    await session.close();
    return { sawTaskTurn, ...summarize(c, { A: a, Q: q }) };
  },

  // 5. Two messages sent close together while idle.
  async "5-close-together"() {
    const { session, c } = await open();
    const x = settle(c.send("X", "Reply with exactly ONE."));
    const y = settle(c.send("Y", "Reply with exactly TWO."));
    const replies = { X: await x, Y: await y };
    await session.close();
    return summarize(c, replies);
  },

  // 5b. The same after the CLI has started (a first exchange warms it up).
  async "5b-close-together-warm"() {
    const { session, c } = await open();
    const w = await settle(c.send("W", "Reply with exactly WARM."));
    const x = settle(c.send("X", "Reply with exactly ONE."));
    const y = settle(c.send("Y", "Reply with exactly TWO."));
    const replies = { W: w, X: await x, Y: await y };
    await session.close();
    return summarize(c, replies);
  },

  // 6a. An error result: max turns reached.
  async "6a-error-max-turns"() {
    const { session, c } = await open({ maxTurns: 1 });
    const a = await settle(
      c.send("A", "Run the Bash command `echo hi`, then reply with exactly OK."),
    );
    const b = await settle(c.send("B", "Reply with exactly AGAIN.", { exclusive: true }));
    await session.close();
    return summarize(c, { A: a, B: b });
  },

  // 6b. An error result from the API: an unknown model.
  async "6b-error-api"() {
    const { session, c } = await open({ model: "claude-nonexistent-model-x" });
    const a = await Promise.race([
      settle(c.send("A", "Reply with exactly OK.")),
      sleep(60_000).then(() => ({ error: "no reply within 60 s" })),
    ]);
    await session.close();
    return summarize(c, { A: a as Reply | { error: string } });
  },

  // 7. Killing the SDK process mid-turn.
  async "7-kill-process"() {
    const { session, c } = await open();
    const a = settle(c.send("A", "Write the numbers 1 to 300, one per line, and nothing else."));
    await until(() => c.currentTurn?.text !== undefined && !!c.currentTurn, 30_000);
    await sleep(1000);
    const killed = killDescendants();
    const replyA = await Promise.race([
      a,
      sleep(30_000).then(() => ({ error: "still waiting after 30 s" })),
    ]);
    let afterKill = "";
    try {
      await c.send("B", "Reply with exactly OK.");
      afterKill = "send B accepted";
    } catch (error) {
      afterKill = `send B rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
    await session.close().catch(() => {});
    return {
      killedPids: killed.length,
      afterKill,
      streamEnded: c.streamEnded,
      ...summarize(c, { A: replyA as Reply | { error: string } }),
    };
  },

  // 8. An interactive card parks a turn; the answer comes as a new message.
  async "8-interactive-card"() {
    const { session, c } = await open({ cards: true });
    const a = await settle(
      c.send(
        "A",
        "Use the ask_question tool to ask me which colour I prefer, single choice between red and blue. Do nothing else.",
      ),
    );
    const b = await settle(c.send("B", "Red.", { exclusive: true }));
    await session.close();
    return summarize(c, { A: a, B: b });
  },

  // 9. submit_output inside a turn a follow-up was folded into.
  async "9-submit-output-folded"() {
    const { session, c } = await open({ handback: true });
    const a = settle(
      c.send(
        "A",
        "Run the Bash command `sleep 4; echo hi` (not in background). Then call submit_output with title 'Fruit' and items ['apple']. Then reply with exactly DONE.",
      ),
    );
    await until(() => (c.currentTurn?.tools.length ?? 0) > 0, 30_000);
    await sleep(1500);
    const s = settle(c.send("S", "Also include 'banana' in the items."));
    const replies = { A: await a, S: await s };
    await session.close();
    return summarize(c, replies);
  },
};

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(cases)) {
  if (wanted.length > 0 && !wanted.some((w) => name.startsWith(w))) continue;
  const started = Date.now();
  let result: CaseResult;
  try {
    result = await run();
  } catch (error) {
    result = { crashed: error instanceof Error ? error.stack : String(error) };
  }
  result = { case: name, seconds: Math.round((Date.now() - started) / 1000), ...result };
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
process.exit(0);
