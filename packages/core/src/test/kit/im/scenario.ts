import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PeerExchange } from "./peer.js";
import type { TestChannel } from "./test-channel.js";
import {
  TRACE_META_KEY,
  TRACE_VERSION,
  type TraceCheck,
  type TraceEvent,
  type TraceExchange,
  type TraceStep,
  traceSchema,
} from "./trace.js";

/** The parts of Rstest's `task` a scenario reads and writes. */
interface ScenarioTask {
  id: string;
  meta: Record<string, unknown>;
}

/** What a scenario body uses to run itself. */
export interface ScenarioContext {
  /** Runs `run` as one labelled step and resolves with its result. A failing
   *  step fails the test with the step's label in the message. */
  step<T>(label: string, run: () => Promise<T> | T): Promise<T>;
  /** Records what the agent emitted or what Rome did, now. */
  note(lane: TraceEvent["lane"], label: string, detail?: unknown): void;
  /** Records invariant verdicts, then throws naming every one that failed. */
  check(results: TraceCheck[]): void;
}

/**
 * Runs a scenario against `channel` as a sequence of labelled steps, so a
 * failure names the step it happened in, not only the assertion.
 *
 * When `ROME_CHANNEL_TRACES` names a directory, the scenario is also recorded:
 * each step and what the conversation shows after it, every message the
 * platform created or edited, every request the platform answered, what the
 * scenario noted and the invariants it checked, on one clock. The trace is
 * written under that directory and named in `task.meta`,
 * whether the scenario passes or fails, for the reporter and the browser UI
 * (packages/channel-test-ui).
 */
export async function runScenario(
  task: ScenarioTask,
  channel: TestChannel,
  body: (context: ScenarioContext) => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const since = (time: number) => time - started;
  const steps: TraceStep[] = [];
  const events: TraceEvent[] = [];
  const checks: TraceCheck[] = [];
  let passed = false;

  try {
    await body({
      note(lane, label, detail) {
        events.push({
          at: since(performance.now()),
          lane,
          label,
          ...(detail === undefined ? {} : { detail }),
        });
      },
      check(results) {
        checks.push(...results);
        const broken = results.filter((result) => !result.ok);
        if (broken.length)
          throw new Error(
            `Invariants broken:\n${broken.map((result) => `  ${result.id}: ${result.detail}`).join("\n")}`,
          );
      },
      async step(label, run) {
        const startedAt = since(performance.now());
        const finish = (error?: string) =>
          steps.push({
            label,
            status: error === undefined ? "passed" : "failed",
            ...(error === undefined ? {} : { error }),
            startedAt,
            durationMs: since(performance.now()) - startedAt,
            visible: channel.peer.visible(channel.conversation),
          });
        try {
          const value = await run();
          finish();
          return value;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          finish(reason);
          const message = `Step "${label}": ${reason}`;
          // Rewriting the message keeps an assertion's diff. A DOMException's
          // message cannot be rewritten, so it is wrapped instead.
          if (error instanceof Error && Reflect.set(error, "message", message)) throw error;
          throw new Error(message, { cause: error });
        }
      },
    });
    passed = true;
  } finally {
    const directory = process.env.ROME_CHANNEL_TRACES;
    if (directory) {
      try {
        await writeTrace(directory, task, channel, { steps, events, checks }, started);
      } catch (error) {
        // A trace that cannot be written must not hide why the scenario failed.
        if (passed) throw error;
      }
    }
  }
}

async function writeTrace(
  directory: string,
  task: ScenarioTask,
  channel: TestChannel,
  recorded: { steps: TraceStep[]; events: TraceEvent[]; checks: TraceCheck[] },
  started: number,
): Promise<void> {
  const since = (time: number) => time - started;
  // Requests answered before the scenario started (login, earlier polls)
  // belong to the channel's setup, not to it.
  const exchanges = channel.peer.server.exchanges
    .filter((exchange) => exchange.answeredAt === undefined || exchange.answeredAt >= started)
    .map((exchange) => toTrace(exchange, since));
  const trace = traceSchema.parse({
    version: TRACE_VERSION,
    platform: channel.platform,
    conversation: channel.conversation,
    steps: recorded.steps,
    exchanges,
    changes: channel.peer
      .changes(channel.conversation)
      .map((change) => ({ at: since(change.at), message: change.message })),
    events: recorded.events,
    checks: recorded.checks,
  });
  const file = resolve(directory, "traces", `${task.id.replace(/[^\w.-]/g, "_")}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`);
  task.meta[TRACE_META_KEY] = file;
}

function toTrace(exchange: PeerExchange, since: (time: number) => number): TraceExchange {
  return {
    method: exchange.request.method,
    path: exchange.request.path,
    requestBody: exchange.request.body,
    ...(exchange.response
      ? { status: exchange.response.status, responseBody: exchange.response.body }
      : {}),
    ...(exchange.source ? { source: exchange.source } : {}),
    accepted: exchange.accepted,
    ...(exchange.dropped ? { dropped: true } : {}),
    receivedAt: since(exchange.receivedAt),
    ...(exchange.answeredAt !== undefined ? { answeredAt: since(exchange.answeredAt) } : {}),
  };
}
