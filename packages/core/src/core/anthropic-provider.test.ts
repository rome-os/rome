import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as claudeAgentSdkModule from "@anthropic-ai/claude-agent-sdk" with {
  rstest: "importActual",
};
import * as anthropicLoginModule from "../lib/anthropic-login.js" with { rstest: "importActual" };
import { AnthropicProvider } from "./anthropic-provider.js";
import type { AgentMessage } from "../types.js";
import { isModelBackgroundTaskEvent, isModelTurnEvent } from "./agent-runner.js";
import { expectModelSessionTurnContract } from "../test/model-session-contract.js";
import type {
  ModelSession,
  ModelSessionEvent,
  ModelSessionForkOpenParams,
  ModelSessionParams,
} from "./agent-runner.js";
import { ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING } from "../lib/anthropic-compatible-providers.js";

const {
  queryMock,
  createSdkMcpServerMock,
  sdkToolMock,
  markAnthropicAuthRevokedMock,
  clearAnthropicAuthRevokedMock,
} = rs.hoisted(() => ({
  queryMock: rs.fn(),
  createSdkMcpServerMock: rs.fn((config: unknown) => config),
  sdkToolMock: rs.fn(
    (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  ),
  markAnthropicAuthRevokedMock: rs.fn(),
  clearAnthropicAuthRevokedMock: rs.fn(),
}));

rs.mock("@anthropic-ai/claude-agent-sdk", () => ({
  ...claudeAgentSdkModule,
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  tool: sdkToolMock,
}));

rs.mock("../lib/anthropic-login.js", () => ({
  ...anthropicLoginModule,
  markAnthropicAuthRevoked: markAnthropicAuthRevokedMock,
  clearAnthropicAuthRevoked: clearAnthropicAuthRevokedMock,
}));

// The send a canned turn answers. The SDK echoes a send's uuid on the first
// frame of the turn that answers it; a turn with no echo is one it started.
const SENT = "00000000-0000-4000-8000-0000000000aa";

// Mock SDK Query: yields the canned messages then ends. The provider's
// events generator reads from this; the consumer drains it once and we
// then close the session.
function mockQuery(messages: unknown[], contextUsage?: unknown) {
  const iter = {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    interrupt: rs.fn(async () => {}),
    close: rs.fn(),
    ...(contextUsage
      ? {
          getContextUsage: rs.fn(async () => contextUsage),
        }
      : {}),
  };
  queryMock.mockReturnValue(iter);
  return iter;
}

function mockThrowingQuery(error: unknown) {
  const iter = {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    interrupt: rs.fn(async () => {}),
    close: rs.fn(),
  };
  queryMock.mockReturnValue(iter);
  return iter;
}

async function collectEvents(session: ModelSession): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const msg of session.events) {
    // Turn boundaries and background tasks have their own tests.
    if (isModelTurnEvent(msg) || isModelBackgroundTaskEvent(msg)) continue;
    // Strip non-deterministic timestamps so deep-equal stays stable.
    const stripped = { ...(msg as unknown as Record<string, unknown>) };
    delete stripped.startedAt;
    delete stripped.endedAt;
    messages.push(stripped as unknown as AgentMessage);
  }
  return messages;
}

/** The provider's AgentMessages without the turn boundaries around them. */
async function* withoutTurnEvents(
  events: AsyncIterable<ModelSessionEvent>,
): AsyncGenerator<AgentMessage> {
  for await (const event of events) {
    if (!isModelTurnEvent(event) && !isModelBackgroundTaskEvent(event)) yield event;
  }
}

function buildParams(overrides: Partial<ModelSessionParams> = {}): ModelSessionParams {
  return {
    model: "claude-test",
    systemPrompt: "system",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    sessionId: "test-session",
    isNewSession: true,
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "delegated",
    ...overrides,
  };
}

function buildForkOpenParams(
  overrides: Partial<ModelSessionForkOpenParams> = {},
): ModelSessionForkOpenParams {
  const params = buildParams(
    overrides as Partial<ModelSessionParams>,
  ) as Partial<ModelSessionParams>;
  delete params.sessionId;
  delete params.isNewSession;
  delete params.providerThreadId;
  delete params.fork;
  return params as ModelSessionForkOpenParams;
}

describe("AnthropicProvider", () => {
  // Stream shapes captured from claude-agent-sdk 0.3.281 with every send
  // stamped with a uuid and origin {kind:"human"} (rome-os/rome#510; spike
  // rome-work@40ed8da research/spike-sdk-turns.md). The provider reports each
  // SDK turn as it happens and names the sends its echo answers; it holds no
  // turn of its own and never waits for one.
  describe("turns follow the SDK's turns", () => {
    const a = "00000000-0000-4000-8000-00000000000a";
    const s = "00000000-0000-4000-8000-00000000000b";
    const say = (text: string, echo?: string) => ({
      type: "assistant",
      session_id: "sdk-thread",
      parent_tool_use_id: null,
      uuid: `assistant-${text}`,
      ...(echo ? { user_message_uuid: echo, user_message_uuids: [echo] } : {}),
      message: { content: [{ type: "text", text }] },
    });
    const result = (text: string, echo: string[], origin?: string, numTurns = 1) => ({
      type: "result",
      subtype: "success",
      result: text,
      num_turns: numTurns,
      stop_reason: numTurns ? "end_turn" : null,
      total_cost_usd: 0,
      duration_ms: 1,
      ...(echo.length ? { user_message_uuid: echo.at(-1), user_message_uuids: echo } : {}),
      ...(origin ? { origin: { kind: origin } } : {}),
    });
    const notification = {
      type: "system",
      subtype: "task_notification",
      task_id: "b1",
      status: "completed",
      output_file: "",
      summary: "done",
    };

    function scripted(script: (sent: () => Promise<{ uuid: string }>) => AsyncGenerator<unknown>) {
      queryMock.mockImplementation(({ prompt }) => {
        const inputs = prompt[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]: () =>
            script(async () => (await inputs.next()).value as { uuid: string }),
          interrupt: rs.fn(async () => {}),
          close: rs.fn(),
        };
      });
    }

    // A compact view of the stream: turn events plus the messages that matter.
    type Seen = string;
    function view(event: ModelSessionEvent): Seen | undefined {
      switch (event.type) {
        case "model_turn_start":
          return `start [${event.answers.map(label)}]`;
        case "model_turn_answers":
          return event.added.length > 0 ? `answers +[${event.added.map(label)}]` : undefined;
        case "model_turn_end":
          return `end [${event.answers.map(label)}]`;
        case "input_status":
          return `${event.state} ${label(event.inputId)}`;
        case "result":
          return `result ${event.content}`;
        case "error":
          return `error ${event.error}`;
        case "text":
          return `text ${event.content}`;
        case "background_tasks":
          return `tasks [${event.tasks.map((task) => `${task.id}:${task.kind}`)}]`;
        case "background_task_end":
          return `ended ${event.end.id} ${event.end.status}`;
        default:
          return undefined;
      }
    }
    function label(id: string): string {
      return id === a ? "A" : id === s ? "S" : id;
    }

    /** Read until `count` turns have ended, or the stream ends. */
    async function read(session: ModelSession, count = Infinity): Promise<Seen[]> {
      const events: ModelSessionEvent[] = [];
      const seen: Seen[] = [];
      let ended = 0;
      for await (const event of session.events) {
        events.push(event);
        const line = view(event);
        if (line) seen.push(line);
        if (event.type === "model_turn_end" && ++ended >= count) break;
      }
      expectModelSessionTurnContract(events, {
        allowUnfinished: events.at(-1)?.type !== "model_turn_end",
      });
      return seen;
    }

    it("reports a turn, the send its echo names, and its end", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("Hi", prompt.uuid);
        yield result("Hi", [prompt.uuid], "human");
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Hello", inputId: a });
      expect(await read(session, 1)).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text Hi",
        "result Hi",
        "end [A]",
      ]);
      await session.close();
    });

    it("reports a turn the SDK starts for a finished background task, answering nothing", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("DONE", prompt.uuid);
        yield result("DONE", [prompt.uuid], "human");
        yield notification;
        yield say("The task finished.");
        yield result("The task finished.", [], "task-notification");
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Start it", inputId: a });
      expect(await read(session, 2)).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text DONE",
        "result DONE",
        "end [A]",
        "ended b1 completed",
        "start []",
        "text The task finished.",
        "result The task finished.",
        "end []",
      ]);
      await session.close();
    });

    it("reports background tasks between turns in Rome's words", async () => {
      scripted(async function* (sent) {
        const first = await sent();
        yield { ...first, isReplay: true };
        yield say("DONE", first.uuid);
        yield result("DONE", [first.uuid], "human");
        // No Rome turn is open from here.
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "b1", task_type: "local_bash", description: "sleep 900" },
            { task_id: "s1", task_type: "local_agent", description: "research" },
            { task_id: "w1", task_type: "monitor", description: "watcher", ambient: true },
          ],
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "b0",
          status: "stopped",
          reason: "worker_restart",
          output_file: "",
          summary: "orphaned",
        };
        yield { ...notification, task_id: "w1", ambient: true };
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Start it.", inputId: a });
      expect(await read(session)).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text DONE",
        "result DONE",
        "end [A]",
        "tasks [b1:shell,s1:agent]",
        "ended b0 lost",
      ]);
      await session.close();
    });

    it("reports a resumed session's empty notification result as its own turn (#510)", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield notification;
        yield result("", [], "task-notification", 0);
        yield { ...prompt, isReplay: true };
        yield say("PONG", prompt.uuid);
        yield result("PONG", [prompt.uuid], "human");
      });
      const session = await new AnthropicProvider().openSession(
        buildParams({ isNewSession: false, providerThreadId: "thread-1" }),
      );
      await session.sendUserInput({ text: "Reply with PONG.", inputId: a });
      expect(await read(session, 2)).toEqual([
        "ended b1 completed",
        "start []",
        "result ",
        "end []",
        "start []",
        "read A",
        "answers +[A]",
        "text PONG",
        "result PONG",
        "end [A]",
      ]);
      await session.close();
    });

    it("sends a follow-up at once and reports the SDK carrying it to its own turn", async () => {
      const sends: { uuid: string; origin?: unknown; priority?: string }[] = [];
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("1 2 3", prompt.uuid);
        const steer = await sent();
        sends.push(prompt, steer);
        yield result("1 2 3", [prompt.uuid], "human");
        yield { ...steer, isReplay: true };
        yield say("BANANA", steer.uuid);
        yield result("BANANA", [steer.uuid], "human");
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Count", inputId: a });
      const reading = read(session, 2);
      expect(await session.steerUserInput!({ text: "Then BANANA", inputId: s })).toBe("accepted");
      expect(await reading).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text 1 2 3",
        "result 1 2 3",
        "end [A]",
        "start []",
        "read S",
        "answers +[S]",
        "text BANANA",
        "result BANANA",
        "end [S]",
      ]);
      expect(sends.map((m) => [m.uuid, m.origin, m.priority])).toEqual([
        [a, { kind: "human" }, "next"],
        [s, { kind: "human" }, "next"],
      ]);
      await session.close();
    });

    it("reports a follow-up folded into the running turn when its result names it", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("Running the tool.", prompt.uuid);
        const steer = await sent();
        yield { ...steer, isReplay: true };
        // Frames after a fold into a turn Rome started carry no echo.
        yield say("OK BANANA");
        yield result("OK BANANA", [prompt.uuid, steer.uuid], "human", 2);
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Run it", inputId: a });
      const reading = read(session, 1);
      await session.steerUserInput!({ text: "Also BANANA", inputId: s });
      expect(await reading).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        // A text block is held until the next one starts, so it follows S's replay.
        "read S",
        "text Running the tool.",
        "text OK BANANA",
        "result OK BANANA",
        "answers +[S]",
        "end [A,S]",
      ]);
      await session.close();
    });

    it("reports a send folded into a turn the SDK started from its echo", async () => {
      scripted(async function* (sent) {
        yield notification;
        yield say("Checking the task.");
        const summon = await sent();
        yield { ...summon, isReplay: true };
        yield say("SUMMONED", summon.uuid);
        yield result("SUMMONED", [summon.uuid], "human", 2);
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      const reading = read(session, 1);
      await new Promise((resolve) => setImmediate(resolve));
      await session.sendUserInput({ text: "Reply SUMMONED", inputId: a });
      expect(await reading).toEqual([
        "ended b1 completed",
        "start []",
        "read A",
        "answers +[A]",
        // Held until the next block starts, so it follows the fold.
        "text Checking the task.",
        "text SUMMONED",
        "result SUMMONED",
        "end [A]",
      ]);
      await session.close();
    });

    it("ends a turn on an error result, naming the send it echoes", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("Calling a tool.", prompt.uuid);
        yield {
          type: "result",
          subtype: "error_max_turns",
          num_turns: 2,
          total_cost_usd: 0,
          duration_ms: 1,
          errors: ["Reached maximum number of turns (1)"],
          user_message_uuid: prompt.uuid,
          user_message_uuids: [prompt.uuid],
        };
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Run it", inputId: a });
      const seen = await read(session, 1);
      expect(seen[0]).toBe("start []");
      expect(seen.slice(-2)).toEqual(["error Reached maximum number of turns (1)", "end [A]"]);
      await session.close();
    });

    it("settles the messages still waiting with a frameless error that names none", async () => {
      let controller!: AbortController;
      const interrupt = rs.fn(async () => {});
      queryMock.mockImplementation(({ prompt, options }) => {
        controller = options.abortController;
        return {
          async *[Symbol.asyncIterator]() {
            const inputs = prompt[Symbol.asyncIterator]();
            await inputs.next();
            // A zeroed result: no frames, no echo; the SDK answers nothing after it.
            yield {
              type: "result",
              subtype: "error_during_execution",
              num_turns: 0,
              total_cost_usd: 0,
              duration_ms: 1,
              errors: ["worker crashed"],
            };
            if (!controller.signal.aborted) {
              await new Promise<void>((resolve) =>
                controller.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            }
          },
          interrupt,
          close: rs.fn(),
        };
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Hello", inputId: a });
      const events = session.events[Symbol.asyncIterator]();
      const seen: string[] = [];
      for (;;) {
        const next = await events.next();
        const line = next.done ? undefined : view(next.value);
        if (line) seen.push(line);
        if (next.done || next.value.type === "model_turn_end") break;
      }
      expect(seen).toEqual(["start []", "error worker crashed", "answers +[A]", "end [A]"]);
      // Nothing is left running, and a later interrupt makes up no second reply.
      await expect(
        session.fork({ sessionId: "fork-after", mode: "thread" }),
      ).resolves.toBeDefined();
      const rest = (async () => {
        const lines: string[] = [];
        for (;;) {
          const next = await events.next();
          if (next.done) return lines;
          const line = view(next.value);
          if (line) lines.push(line);
        }
      })();
      await session.interrupt("user-stop");
      expect(interrupt).toHaveBeenCalledOnce();
      await session.close();
      expect(await rest).toEqual([]);
    });

    it("leaves waiting messages alone after a frameless error from a background task", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield {
          type: "result",
          subtype: "error_during_execution",
          num_turns: 0,
          total_cost_usd: 0,
          duration_ms: 1,
          errors: ["notification failed"],
          origin: { kind: "task-notification" },
        };
        yield { ...prompt, isReplay: true };
        yield say("Hi", prompt.uuid);
        yield result("Hi", [prompt.uuid], "human");
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "Hello", inputId: a });
      expect(await read(session, 2)).toEqual([
        "start []",
        "error notification failed",
        "end []",
        "start []",
        "read A",
        "answers +[A]",
        "text Hi",
        "result Hi",
        "end [A]",
      ]);
      await session.close();
    });

    function interruptResult(ids: string[]) {
      return {
        type: "result",
        subtype: "error_during_execution",
        terminal_reason: "aborted_streaming",
        result: "",
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        errors: ["interrupted"],
        ...(ids.length ? { user_message_uuid: ids.at(-1), user_message_uuids: ids } : {}),
      };
    }

    it("keeps a send that races Stop before SDK acceptance for its next SDK turn", async () => {
      let releaseInterrupt!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          await interrupted;
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const input = (await inputs.next()).value;
          yield { ...input, isReplay: true };
          yield say("after Stop", input.uuid);
          yield result("after Stop", [input.uuid], "human");
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 1);
      await session.interrupt("user-stop");
      expect(q.interrupt).toHaveBeenCalledOnce();
      expect(await reading).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text after Stop",
        "result after Stop",
        "end [A]",
      ]);
      await session.close();
    });

    it.each([
      { label: "cold", params: buildParams() },
      {
        label: "warm",
        params: buildParams({ isNewSession: false, providerThreadId: "sdk-thread" }),
      },
    ])("uses the SDK result when Stop arrives before replay in a $label session", async ({
      params,
    }) => {
      let releaseInterrupt!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const input = (await inputs.next()).value;
          await interrupted;
          yield { ...input, isReplay: true };
          yield interruptResult([input.uuid]);
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(params);
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 1);
      await new Promise((resolve) => setImmediate(resolve));
      await session.interrupt("user-stop");
      expect(q.interrupt).toHaveBeenCalledOnce();
      expect(await reading).toEqual([
        "start []",
        "read A",
        "error interrupted",
        "answers +[A]",
        "end [A]",
      ]);
      await session.close();
    });

    it("uses the SDK result when Stop arrives after replay but before its first frame", async () => {
      let releaseInterrupt!: () => void;
      let replayed!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const replay = new Promise<void>((resolve) => {
        replayed = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const input = (await inputs.next()).value;
          yield { ...input, isReplay: true };
          replayed();
          await interrupted;
          yield interruptResult([input.uuid]);
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 1);
      await replay;
      await session.interrupt("user-stop");
      expect(await reading).toEqual([
        "start []",
        "read A",
        "error interrupted",
        "answers +[A]",
        "end [A]",
      ]);
      await session.close();
    });

    it("keeps B queued through a mid-stream Stop and lets the SDK run it", async () => {
      let releaseInterrupt!: () => void;
      let streaming!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const streamStarted = new Promise<void>((resolve) => {
        streaming = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const first = (await inputs.next()).value;
          yield { ...first, isReplay: true };
          yield say("working", first.uuid);
          streaming();
          await interrupted;
          yield interruptResult([first.uuid]);
          const second = (await inputs.next()).value;
          yield { ...second, isReplay: true };
          yield say("B completed", second.uuid);
          yield result("B completed", [second.uuid], "human");
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 2);
      await streamStarted;
      await session.steerUserInput!({ text: "B", inputId: s });
      await session.interrupt("user-stop");
      expect(await reading).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text working",
        "error interrupted",
        "end [A]",
        "start []",
        "read S",
        "answers +[S]",
        "text B completed",
        "result B completed",
        "end [S]",
      ]);
      await session.close();
    });

    it("uses the SDK error result when Stop interrupts a tool", async () => {
      let releaseInterrupt!: () => void;
      let toolStarted!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const started = new Promise<void>((resolve) => {
        toolStarted = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const input = (await inputs.next()).value;
          yield { ...input, isReplay: true };
          yield {
            type: "assistant",
            uuid: "assistant-tool",
            session_id: "sdk-thread",
            parent_tool_use_id: null,
            user_message_uuid: input.uuid,
            message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] },
          };
          toolStarted();
          await interrupted;
          yield interruptResult([input.uuid]);
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 1);
      await started;
      await session.interrupt("user-stop");
      const seen = await reading;
      expect(seen.slice(-3)).toEqual(["answers +[A]", "error interrupted", "end [A]"]);
      await session.close();
    });

    it("settles a folded S from the SDK result even when Stop follows its replay", async () => {
      let releaseInterrupt!: () => void;
      let steerReplayed!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const replayed = new Promise<void>((resolve) => {
        steerReplayed = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const first = (await inputs.next()).value;
          yield { ...first, isReplay: true };
          yield {
            type: "assistant",
            uuid: "assistant-tool",
            session_id: "sdk-thread",
            parent_tool_use_id: null,
            user_message_uuid: first.uuid,
            message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] },
          };
          const steer = (await inputs.next()).value;
          yield { ...steer, isReplay: true };
          steerReplayed();
          await interrupted;
          yield interruptResult([first.uuid, steer.uuid]);
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 1);
      await session.steerUserInput!({ text: "S", inputId: s });
      await replayed;
      await session.interrupt("user-stop");
      const seen = await reading;
      expect(seen).toContain("answers +[S]");
      expect(seen.at(-1)).toBe("end [A,S]");
      await session.close();
    });

    it("flushes delta-only text on Stop without leaking it into the next turn", async () => {
      let releaseInterrupt!: () => void;
      let streaming!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const started = new Promise<void>((resolve) => {
        streaming = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const first = (await inputs.next()).value;
          yield { ...first, isReplay: true };
          yield {
            type: "stream_event",
            session_id: "sdk-thread",
            parent_tool_use_id: null,
            user_message_uuid: first.uuid,
            event: { type: "message_start", message: { id: "msg_A" } },
          };
          yield {
            type: "stream_event",
            session_id: "sdk-thread",
            parent_tool_use_id: null,
            user_message_uuid: first.uuid,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "partial" },
            },
          };
          streaming();
          await interrupted;
          yield interruptResult([first.uuid]);
          const second = (await inputs.next()).value;
          yield { ...second, isReplay: true };
          yield say("next", second.uuid);
          yield result("next", [second.uuid], "human");
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 2);
      await started;
      await session.interrupt("user-stop");
      await session.sendUserInput({ text: "S", inputId: s });
      const seen = await reading;
      expect(seen).toEqual([
        "start []",
        "read A",
        "answers +[A]",
        "text partial",
        "error interrupted",
        "end [A]",
        "start []",
        "read S",
        "answers +[S]",
        "text next",
        "result next",
        "end [S]",
      ]);
      await session.close();
    });

    it("accepts the next message after Stop in the same SDK Query", async () => {
      let releaseInterrupt!: () => void;
      let interruptedTurnEnded!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
      const ended = new Promise<void>((resolve) => {
        interruptedTurnEnded = resolve;
      });
      const q = {
        interrupt: rs.fn(async () => releaseInterrupt()),
        close: rs.fn(),
        async *[Symbol.asyncIterator]() {
          const inputs = queryMock.mock.calls[0]![0].prompt[Symbol.asyncIterator]();
          const first = (await inputs.next()).value;
          yield { ...first, isReplay: true };
          await interrupted;
          yield interruptResult([first.uuid]);
          interruptedTurnEnded();
          const next = (await inputs.next()).value;
          yield { ...next, isReplay: true };
          yield say("next", next.uuid);
          yield result("next", [next.uuid], "human");
        },
      };
      queryMock.mockReturnValue(q);
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const reading = read(session, 2);
      await new Promise((resolve) => setImmediate(resolve));
      await session.interrupt("user-stop");
      await ended;
      await session.sendUserInput({ text: "S", inputId: s });
      expect(await reading).toEqual(expect.arrayContaining(["end [A]", "result next", "end [S]"]));
      await session.close();
    });

    it("does not invent a model turn when the process dies without a result", async () => {
      scripted(async function* (sent) {
        const prompt = await sent();
        yield { ...prompt, isReplay: true };
        yield say("partial", prompt.uuid);
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "A", inputId: a });
      const seen = await read(session);
      expect(seen).toEqual(["start []", "read A", "answers +[A]", "text partial"]);
      expect(session.isClosed).toBe(true);
      await session.close();
    });

    it("stops counting a send as running once the SDK replays it or a result names it", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      scripted(async function* (sent) {
        const first = await sent();
        // Picked up by its replay alone (this turn's result names nothing).
        yield { ...first, isReplay: true };
        yield say("one");
        yield result("one", [], "human");
        const second = await sent();
        // Picked up by the result's echo alone (no replay).
        yield say("two");
        yield result("two", [second.uuid], "human");
        await gate;
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      const events = session.events[Symbol.asyncIterator]();
      const untilEnd = async () => {
        for (;;) {
          const next = await events.next();
          if (next.done || next.value.type === "model_turn_end") return;
        }
      };
      await session.sendUserInput({ text: "one", inputId: a });
      await untilEnd();
      await expect(session.fork({ sessionId: "fork-a", mode: "thread" })).resolves.toBeDefined();
      await session.sendUserInput({ text: "two", inputId: s });
      await untilEnd();
      await expect(session.fork({ sessionId: "fork-s", mode: "thread" })).resolves.toBeDefined();
      release();
      await session.close();
    });

    it("reports input status only for replays of Rome's own sends", async () => {
      const sends: { uuid?: string; origin?: unknown }[] = [];
      scripted(async function* (sent) {
        const minted = await sent();
        sends.push(minted);
        yield { ...minted, isReplay: true };
        yield say("title", minted.uuid);
        yield result("title", [minted.uuid], "human");
        yield {
          type: "user",
          isReplay: true,
          uuid: "notification-uuid",
          origin: { kind: "task-notification" },
          parent_tool_use_id: null,
          message: { role: "user", content: [{ type: "text", text: "<task-notification/>" }] },
        };
        yield say("noted");
        yield result("noted", [], "task-notification");
      });
      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "title this" });
      const seen = await read(session, 2);
      expect(sends[0]?.uuid).toEqual(expect.any(String));
      expect(sends[0]?.origin).toEqual({ kind: "human" });
      expect(seen.filter((line) => line.startsWith("consumed"))).toEqual([]);
      await session.close();
    });
  });

  beforeEach(() => {
    rs.clearAllMocks();
    markAnthropicAuthRevokedMock.mockResolvedValue(undefined);
    clearAnthropicAuthRevokedMock.mockResolvedValue(undefined);
    mockQuery([
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
  });

  it("allows TodoWrite as a builtin tool", () => {
    const provider = new AnthropicProvider();

    expect(provider.builtinTools.has("TodoWrite")).toBe(true);
  });

  it("uses SDK outputFormat and publishes only the native structured terminal", async () => {
    const schema = {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    };
    const structuredOutput = { value: 7 };
    mockQuery([
      {
        type: "assistant",
        uuid: "assistant-structured",
        session_id: "claude-structured",
        parent_tool_use_id: null,
        user_message_uuid: SENT,
        message: { content: [{ type: "text", text: JSON.stringify(structuredOutput) }] },
      },
      {
        type: "result",
        subtype: "success",
        result: JSON.stringify(structuredOutput),
        structured_output: structuredOutput,
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);

    const session = await new AnthropicProvider().openSession(
      buildParams({ outputSchema: schema }),
    );
    await session.sendUserInput({ text: "return seven", inputId: SENT });
    const events = await collectEvents(session);

    expect(queryMock.mock.calls[0]![0].options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
    expect(events.some((event) => event.type === "text" || event.type === "text_delta")).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        content: JSON.stringify(structuredOutput),
        structuredOutput,
      }),
    );
    await session.close();
  });

  it("rejects native structured output that does not match outputSchema", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "success",
        result: '{"value":"seven"}',
        structured_output: { value: "seven" },
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const session = await new AnthropicProvider().openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    await session.sendUserInput({ text: "return seven" });

    expect(await collectEvents(session)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("failed validation"),
      }),
    );
    await session.close();
  });

  it("surfaces SDK structured-output retry exhaustion as a failed turn", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        errors: [],
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const session = await new AnthropicProvider().openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    await session.sendUserInput({ text: "return a value" });
    expect(await collectEvents(session)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("error_max_structured_output_retries"),
      }),
    );
    await session.close();
  });

  it("reserves process abort and close for session close", async () => {
    let controller!: AbortController;
    const q = {
      interrupt: rs.fn(async () => {}),
      close: rs.fn(),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    };
    queryMock.mockImplementation(({ options }) => {
      controller = options.abortController;
      return q;
    });
    const session = await new AnthropicProvider().openSession(buildParams());
    await session.interrupt("user-stop");
    expect(q.interrupt).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(false);
    expect(q.close).not.toHaveBeenCalled();
    await session.close();
    expect(controller.signal.aborted).toBe(true);
    expect(q.close).toHaveBeenCalledOnce();
  });

  it("projects top-level TodoWrite snapshots while preserving generic tool events", async () => {
    const todoMessage = (id: string, todos: unknown, parentToolUseId: string | null = null) => ({
      type: "assistant",
      uuid: `assistant-${id}`,
      session_id: "claude-session",
      parent_tool_use_id: parentToolUseId,
      user_message_uuid: SENT,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }],
      },
    });
    mockQuery([
      todoMessage("todo-1", [
        {
          content: "Inspect the provider",
          activeForm: "Inspecting the provider",
          status: "completed",
        },
        { content: "Build the panel", activeForm: "Building the panel", status: "in_progress" },
      ]),
      // A malformed non-empty list must not clear the last valid snapshot.
      todoMessage("todo-bad", [{ content: "Unknown", activeForm: "Unknown", status: "blocked" }]),
      // SDK-internal child streams cannot replace the parent Plan.
      todoMessage(
        "todo-child",
        [{ content: "Child work", activeForm: "Doing child work", status: "in_progress" }],
        "toolu-subagent",
      ),
      todoMessage("todo-2", [
        {
          content: "Inspect the provider",
          activeForm: "Inspecting the provider",
          status: "completed",
        },
        { content: "Build the panel", activeForm: "Building the panel", status: "completed" },
        { content: "Verify in browser", activeForm: "Verifying in browser", status: "in_progress" },
      ]),
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);

    const provider = new AnthropicProvider();
    const session = await provider.openSession(buildParams());
    await session.sendUserInput({ text: "plan it", inputId: SENT });
    const messages = await collectEvents(session);

    expect(messages.filter((message) => message.type === "plan_update")).toEqual([
      {
        type: "plan_update",
        plan: {
          steps: [
            {
              text: "Inspect the provider",
              activeText: "Inspecting the provider",
              status: "completed",
            },
            {
              text: "Build the panel",
              activeText: "Building the panel",
              status: "in_progress",
            },
          ],
        },
      },
      {
        type: "plan_update",
        plan: {
          steps: [
            {
              text: "Inspect the provider",
              activeText: "Inspecting the provider",
              status: "completed",
            },
            { text: "Build the panel", activeText: "Building the panel", status: "completed" },
            {
              text: "Verify in browser",
              activeText: "Verifying in browser",
              status: "in_progress",
            },
          ],
        },
      },
    ]);
    expect(messages.filter((message) => message.type === "tool_use")).toHaveLength(4);
    await session.close();
  });

  it("disposes the SDK query after an events consumer returns at a terminal", async () => {
    const sdkQuery = mockQuery([
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const provider = new AnthropicProvider();
    const session = await provider.openSession(buildParams());
    const events = withoutTurnEvents(session.events)[Symbol.asyncIterator]();

    const terminal = await events.next();
    expect(terminal.value).toMatchObject({ type: "result" });

    // Fork consumers intentionally stop at the first terminal block. Returning
    // the provider event iterator must not make the later ModelSession.close()
    // mistake "stream ended" for "SDK query already disposed".
    await events.return?.(undefined);
    await session.close();

    expect(sdkQuery.close).toHaveBeenCalledOnce();
  });

  it("opens forked Claude sessions with native resume fork options and a separate input queue", async () => {
    const provider = new AnthropicProvider();

    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "thread",
      sourceCheckpoint: "assistant-message-at-t2",
    });
    const forkSession = await fork.open(
      buildForkOpenParams({ model: "claude-fork", systemPrompt: "fork system" }),
    );

    expect(fork).toMatchObject({
      providerId: "anthropic",
      sessionId: "fork-session",
      sourceSessionId: "source-session",
      mode: "thread",
      providerThreadId: "fork-session",
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          model: "claude-fork",
          systemPrompt: "fork system",
          resume: "source-session",
          forkSession: true,
          sessionId: "fork-session",
          resumeSessionAt: "assistant-message-at-t2",
        }),
      }),
    );
    expect(queryMock.mock.calls[0]![0].prompt).not.toBe(queryMock.mock.calls[1]![0].prompt);

    await forkSession.close();
    await source.close();
  });

  it("rejects a second open of the same Claude fork descriptor", async () => {
    const provider = new AnthropicProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({ sessionId: "fork-session" });
    const opened = await fork.open(buildForkOpenParams());

    await expect(fork.open(buildForkOpenParams())).rejects.toThrow(
      "ModelSession fork already opened",
    );

    await opened.close();
    await source.close();
  });

  describe("session resume gating", () => {
    it("starts a fresh SDK session with the host session id when the session is new", async () => {
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({ sessionId: "fresh-session", isNewSession: true }),
      );

      expect(queryMock.mock.calls[0]![0].options).toMatchObject({ sessionId: "fresh-session" });
      expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();

      await session.close();
    });

    it("uses a fresh SDK id when a reused session has no resumable transcript", async () => {
      // A stored session row with no captured provider thread id — e.g. a turn
      // that short-circuited (the not-logged-in notice) before opening an SDK
      // conversation. Resuming it would fail with "No conversation found".
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({
          sessionId: "reused-session",
          isNewSession: false,
          providerThreadId: undefined,
        }),
      );

      expect(queryMock.mock.calls[0]![0].options.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(queryMock.mock.calls[0]![0].options.sessionId).not.toBe("reused-session");
      expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();

      await session.close();
    });

    it("resumes by provider thread id when a prior transcript was captured", async () => {
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({
          sessionId: "reused-session",
          isNewSession: false,
          providerThreadId: "sdk-thread-123",
        }),
      );

      expect(queryMock.mock.calls[0]![0].options).toMatchObject({ resume: "sdk-thread-123" });
      expect(queryMock.mock.calls[0]![0].options.sessionId).toBeUndefined();

      await session.close();
    });

    it("exposes the SDK session id as providerThreadId once a turn produces content", async () => {
      mockQuery([
        {
          type: "assistant",
          session_id: "sdk-thread-xyz",
          parent_tool_use_id: null,
          user_message_uuid: SENT,
          uuid: "u1",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "hi",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({ sessionId: "host-session", isNewSession: true }),
      );

      expect(session.providerThreadId).toBeUndefined();
      await session.sendUserInput({ text: "hi", inputId: SENT });
      await collectEvents(session);
      expect(session.providerThreadId).toBe("sdk-thread-xyz");
      expect(session.lastCompletedTurnCheckpoint).toBe("u1");

      await session.close();
    });
  });

  it("marks quota before exposing a usage-limit terminal", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "error",
        errors: ["Claude usage limit reached. Please try again later."],
        num_turns: 1,
        stop_reason: "error",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    let quotaMarked = false;
    const provider = new AnthropicProvider({
      env: { PATH: "/usr/bin" },
      onQuotaExhausted: () => {
        quotaMarked = true;
      },
    });
    const session = await provider.openSession(buildParams());

    const terminal = await withoutTurnEvents(session.events)[Symbol.asyncIterator]().next();

    expect(quotaMarked).toBe(true);
    expect(terminal.value).toMatchObject({ type: "error", code: "usage_limit" });
    await session.close();
  });

  describe("auth revoked handling", () => {
    it("tags invalid-credential result errors and waits for the revoked marker before terminal error", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      let resolveMarker!: () => void;
      let resolveMarkerStarted!: () => void;
      const markerStarted = new Promise<void>((resolve) => {
        resolveMarkerStarted = resolve;
      });
      const markerDone = new Promise<void>((resolve) => {
        resolveMarker = resolve;
      });
      markAnthropicAuthRevokedMock.mockImplementationOnce(async () => {
        resolveMarkerStarted();
        await markerDone;
      });
      let authStateMarked = false;
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin" },
        onAuthRevoked: () => {
          authStateMarked = true;
        },
      });
      const session = await provider.openSession(buildParams());
      const iter = withoutTurnEvents(session.events)[Symbol.asyncIterator]();
      const next = iter.next();

      await markerStarted;
      let terminalEmitted = false;
      void next.then(() => {
        terminalEmitted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(terminalEmitted).toBe(false);
      expect(authStateMarked).toBe(false);

      resolveMarker();
      const terminal = await next;

      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledTimes(1);
      expect(authStateMarked).toBe(true);
      expect(terminal).toMatchObject({
        done: false,
        value: {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          code: "auth_revoked",
        },
      });

      await session.close();
    });

    it("persists a thrown invalid credential error without inventing an SDK turn", async () => {
      mockThrowingQuery(new Error("OAuth token revoked · Please run /login"));
      const provider = new AnthropicProvider({ env: { PATH: "/usr/bin" } });
      const session = await provider.openSession(buildParams());
      await session.sendUserInput({ text: "Hello", inputId: SENT });

      await expect(collectEvents(session)).rejects.toMatchObject({
        message: "OAuth token revoked · Please run /login",
        code: "auth_revoked",
        provider: "anthropic",
      });
      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledTimes(1);

      await session.close();
    });

    it("classifies a thrown usage-limit error for AgentSession", async () => {
      mockThrowingQuery(new Error("Claude usage limit reached. Please try again later."));
      let quotaMarked = false;
      const provider = new AnthropicProvider({
        onQuotaExhausted: () => {
          quotaMarked = true;
        },
      });
      const session = await provider.openSession(buildParams());
      await session.sendUserInput({ text: "Hello", inputId: SENT });

      await expect(collectEvents(session)).rejects.toMatchObject({
        code: "usage_limit",
        provider: "anthropic",
      });
      expect(quotaMarked).toBe(true);

      await session.close();
    });

    it("scopes invalid stored Anthropic-compatible credentials to the provider API key", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "deepseek",
            apiKey: "deepseek-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });
      const session = await provider.openSession(buildParams());

      const messages = await collectEvents(session);

      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stored-compatible",
          provider: "deepseek",
          apiKeyHash: expect.any(String),
        }),
      );
      expect(JSON.stringify(markAnthropicAuthRevokedMock.mock.calls[0]?.[0])).not.toContain(
        "deepseek-key",
      );
      expect(messages).toEqual([
        {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          code: "auth_revoked",
        },
      ]);

      await session.close();
    });

    it("does not persist a Claude revoked marker for invalid raw env API keys", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "env-token" },
      });
      const session = await provider.openSession(buildParams());

      const messages = await collectEvents(session);

      expect(markAnthropicAuthRevokedMock).not.toHaveBeenCalled();
      expect(messages).toEqual([
        {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
      ]);

      await session.close();
    });
  });

  describe("buildQueryEnv", () => {
    it("passes sandbox mode to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", IS_SANDBOX: "0" },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: "high",
            env: expect.objectContaining({
              PATH: "/usr/bin",
              IS_SANDBOX: "1",
              CLAUDE_CODE_EFFORT_LEVEL: "high",
            }),
          }),
        }),
      );
    });

    it.each([
      ["low", "low"],
      ["high", "high"],
      ["xhigh", "max"],
    ] as const)("maps %s reasoning effort to Claude effort %s", async (configured, expected) => {
      const provider = new AnthropicProvider({ env: { PATH: "/usr/bin" } });

      const session = await provider.openSession(buildParams({ reasoningEffort: configured }));
      // Claude fixes effort at open and reports it in its own terms.
      expect(session.appliedReasoningEffort).toBe(expected);
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: expected,
            env: expect.objectContaining({ CLAUDE_CODE_EFFORT_LEVEL: expected }),
          }),
        }),
      );
    });

    it("passes stored Anthropic-compatible provider credentials to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "old-token" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "deepseek",
            apiKey: "deepseek-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: "deepseek-v4-pro[1m]",
            env: expect.objectContaining({
              PATH: "/usr/bin",
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
              ANTHROPIC_AUTH_TOKEN: "deepseek-key",
              ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
              CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
              CLAUDE_CODE_EFFORT_LEVEL: "high",
            }),
          }),
        }),
      );
    });

    it("uses a custom provider env without inherited Anthropic or Claude Code values", async () => {
      const provider = new AnthropicProvider({
        env: {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "inherited-key",
          ANTHROPIC_MODEL: "inherited-model",
          CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
          ENABLE_TOOL_SEARCH: "true",
        },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "custom",
            env: {
              ANTHROPIC_AUTH_TOKEN: "ark-key",
              ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
              ANTHROPIC_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_OPUS_MODEL: "ep-model",
              CLAUDE_CODE_SUBAGENT_MODEL: "ep-model",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      await collectEvents(session);
      await session.close();

      expect(session.model).toBe("ep-model");
      const queryEnv = queryMock.mock.calls[0]![0].options.env;
      expect(queryEnv).toMatchObject({
        PATH: "/usr/bin",
        IS_SANDBOX: "1",
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
        ANTHROPIC_MODEL: "ep-model",
        CLAUDE_CODE_SUBAGENT_MODEL: "ep-model",
        CLAUDE_CODE_EFFORT_LEVEL: "high",
      });
      expect(queryEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(queryEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(queryEnv.ENABLE_TOOL_SEARCH).toBeUndefined();
    });

    it("uses Meta's model id instead of the tier-resolved Claude model", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "anthropic-key" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "meta",
            apiKey: "meta-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      await collectEvents(session);
      await session.close();

      expect(session.model).toBe("muse-spark-1.1");
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: "muse-spark-1.1",
            env: expect.objectContaining({
              ANTHROPIC_AUTH_TOKEN: "meta-key",
              ANTHROPIC_BASE_URL: "https://api.meta.ai",
              ANTHROPIC_MODEL: "muse-spark-1.1",
            }),
          }),
        }),
      );
      expect(queryMock.mock.calls[0]![0].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("passes the stored timezone to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", TZ: "UTC" },
        settingsRepo: {
          get: rs
            .fn()
            .mockImplementation(async (key: string) =>
              key === "guardianTimezone" ? "America/Los_Angeles" : null,
            ),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({
              PATH: "/usr/bin",
              TZ: "America/Los_Angeles",
            }),
          }),
        }),
      );
    });

    it("combines stored timezone with Anthropic-compatible provider credentials", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", TZ: "UTC" },
        settingsRepo: {
          get: rs.fn().mockImplementation(async (key: string) => {
            if (key === "guardianTimezone") {
              return "America/New_York";
            }
            if (key === ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING) {
              return {
                provider: "deepseek",
                apiKey: "deepseek-key",
                updatedAt: "2026-04-26T00:00:00.000Z",
              };
            }
            return null;
          }),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({
              PATH: "/usr/bin",
              TZ: "America/New_York",
              ANTHROPIC_AUTH_TOKEN: "deepseek-key",
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
            }),
          }),
        }),
      );
    });
  });

  describe("event translation", () => {
    it("yields text_delta previews from top-level partial stream events only", async () => {
      mockQuery([
        {
          type: "stream_event",
          parent_tool_use_id: null,
          user_message_uuid: SENT,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
        },
        {
          // A tool-input fragment with no `tool_use` block start to attach to.
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"q":' },
          },
        },
        {
          // SDK-internal subagent stream — must be skipped.
          type: "stream_event",
          parent_tool_use_id: "toolu_sub_1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "subagent text" },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        {
          type: "result",
          subtype: "success",
          result: "Hello",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      await session.sendUserInput({ text: "say hello", inputId: SENT });
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        { type: "text_delta", content: "Hel" },
        { type: "text_delta", content: "lo" },
        // Held until the turn ends with nothing following it → the closing answer.
        { type: "text", content: "Hello", turnPhase: "final" },
        { type: "result", content: "Hello" },
      ]);
      // Deltas only flow when partial messages are requested from the SDK.
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ includePartialMessages: true }),
        }),
      );
    });

    it("streams thinking, text, and tool input with block ids that match the completed blocks", async () => {
      // Frame order recorded from SDK 0.3.281: block start, deltas, the
      // completed block as its own assistant message, then block stop.
      const frame = (event: Record<string, unknown>) => ({
        type: "stream_event",
        parent_tool_use_id: null,
        user_message_uuid: SENT,
        event,
      });
      mockQuery([
        frame({ type: "message_start", message: { id: "msg_A" } }),
        frame({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Check the" },
        }),
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: " kernel." },
        }),
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "msg_A", content: [{ type: "thinking", thinking: "Check the kernel." }] },
        },
        frame({ type: "content_block_stop", index: 0 }),
        frame({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
        frame({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Running it." },
        }),
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "msg_A", content: [{ type: "text", text: "Running it." }] },
        },
        frame({ type: "content_block_stop", index: 1 }),
        frame({
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
        }),
        frame({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"command":' },
        }),
        frame({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"uname -s"}' },
        }),
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "msg_A",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "uname -s" } },
            ],
          },
        },
        frame({ type: "content_block_stop", index: 2 }),
        // Next API call: thinking hidden by the provider streams empty deltas.
        frame({ type: "message_start", message: { id: "msg_B" } }),
        frame({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "" },
        }),
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "msg_B", content: [{ type: "thinking", thinking: "" }] },
        },
        frame({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
        frame({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Linux." },
        }),
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "msg_B", content: [{ type: "text", text: "Linux." }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "Linux.",
          num_turns: 2,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const session = await new AnthropicProvider().openSession(buildParams());
      await session.sendUserInput({ text: "which kernel?", inputId: SENT });
      const messages = await collectEvents(session);
      await session.close();

      expect(messages.filter((m) => m.type !== "input_status")).toEqual([
        { type: "thinking_delta", blockId: "msg_A:0", content: "Check the" },
        { type: "thinking_delta", blockId: "msg_A:0", content: " kernel." },
        { type: "thinking", content: "Check the kernel.", blockId: "msg_A:0" },
        { type: "text_delta", content: "Running it.", blockId: "msg_A:1" },
        // The tool input's first fragment confirms the held text was narration.
        { type: "text", content: "Running it.", turnPhase: "commentary", blockId: "msg_A:1" },
        {
          type: "tool_input_delta",
          toolUseId: "toolu_1",
          tool: "Bash",
          content: '{"command":',
        },
        { type: "tool_input_delta", toolUseId: "toolu_1", tool: "Bash", content: '"uname -s"}' },
        {
          type: "tool_use",
          id: "toolu_1",
          tool: "Bash",
          input: { command: "uname -s" },
        },
        // No delta and no thinking block for hidden reasoning.
        { type: "text_delta", content: "Linux.", blockId: "msg_B:1" },
        { type: "text", content: "Linux.", turnPhase: "final", blockId: "msg_B:1" },
        { type: "result", content: "Linux." },
      ]);
    });

    it("emits tool_result messages for builtin SDK tools like WebSearch", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_websearch_1",
                name: "WebSearch",
                input: { query: "rome latest" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_websearch_1",
          tool_use_result: {
            results: [{ title: "Result 1", url: "https://example.com" }],
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_websearch_1",
                content: { results: [{ title: "Result 1", url: "https://example.com" }] },
              },
            ],
          },
          session_id: "sess-1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_websearch_1",
          tool: "WebSearch",
          input: { query: "rome latest" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_websearch_1",
          tool: "WebSearch",
          output: { results: [{ title: "Result 1", url: "https://example.com" }] },
          isError: false,
        },
        { type: "result", content: "Done" },
      ]);
    });

    it("tags text followed by a tool call as commentary and the closing text as final", async () => {
      // No stop_reason is set (the SDK never populates it on streamed assistant
      // messages); tagging is by position only — a text block with a tool call
      // after it is mid-turn narration; the last text before `result` is final.
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me check the weather first." },
              { type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "weather" } },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
          },
          session_id: "sess-1",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "It's sunny." }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "It's sunny.",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      const texts = messages.filter((m) => m.type === "text");
      expect(texts).toEqual([
        { type: "text", content: "Let me check the weather first.", turnPhase: "commentary" },
        { type: "text", content: "It's sunny.", turnPhase: "final" },
      ]);
    });

    it("tags narration as commentary across per-block messages with no stop_reason", async () => {
      // Mirrors the real agent-SDK shape: stop_reason is always null and one API
      // message is split into one `assistant` message per content block (thinking,
      // text, tool_use arrive separately). The lookahead must still tag the
      // narration before the tool call as commentary and only the trailing text
      // — the one nothing follows but `result` — as the final answer.
      mockQuery([
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Let me look that up." }] },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }],
          },
          session_id: "sess-1",
        },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "ok" }] } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "You have two files." }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "You have two files.",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      const texts = messages.filter((m) => m.type === "text");
      expect(texts).toEqual([
        { type: "text", content: "Let me look that up.", turnPhase: "commentary" },
        { type: "text", content: "You have two files.", turnPhase: "final" },
      ]);
    });

    it("falls back to top-level tool_use_result when content blocks are absent", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_action_1",
                name: "execute_action",
                input: { action_name: "demo_action", json_args: { title: "Standup" } },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_action_1",
          tool_use_result: { success: true, data: { id: "evt_123" } },
          message: { role: "user", content: [] },
          session_id: "sess-2",
        },
        {
          type: "result",
          subtype: "success",
          result: "Scheduled",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_action_1",
          tool: "execute_action",
          input: { action_name: "demo_action", json_args: { title: "Standup" } },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_action_1",
          tool: "execute_action",
          output: { success: true, data: { id: "evt_123" } },
        },
        { type: "result", content: "Scheduled" },
      ]);
    });

    it("preserves tool_result error metadata from content blocks", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_webfetch_1",
                name: "WebFetch",
                input: { url: "https://example.com" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_webfetch_1",
          tool_use_result: { content: "Request failed" },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_webfetch_1",
                content: "Request failed",
                is_error: true,
              },
            ],
          },
          session_id: "sess-3",
        },
        {
          type: "result",
          subtype: "success",
          result: "Handled",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_webfetch_1",
          tool: "WebFetch",
          input: { url: "https://example.com" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_webfetch_1",
          tool: "WebFetch",
          output: { content: "Request failed", isError: true },
          isError: true,
        },
        { type: "result", content: "Handled" },
      ]);
    });

    it("normalizes MCP tool names before yielding tool messages", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_subagent_1",
                name: "mcp__subagents__explore",
                input: { prompt: "Inspect src/index.ts" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_subagent_1",
          tool_use_result: "Explore complete",
          message: { role: "user", content: [] },
          session_id: "sess-4",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_subagent_1",
          tool: "explore",
          input: { prompt: "Inspect src/index.ts" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_subagent_1",
          tool: "explore",
          output: "Explore complete",
        },
        { type: "result", content: "Done" },
      ]);
    });
  });

  describe("accounting", () => {
    it("attaches normalized accounting metadata to result messages", async () => {
      mockQuery(
        [
          {
            type: "result",
            subtype: "success",
            result: "Done",
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 400,
            },
            num_turns: 2,
            stop_reason: "end_turn",
            total_cost_usd: 0.00789,
            duration_ms: 50,
          },
        ],
        {
          totalTokens: 12345,
          maxTokens: 900000,
          rawMaxTokens: 1000000,
          percentage: 1.2345,
          categories: [],
          gridRows: [],
          model: "claude-sonnet-5",
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: {
            input_tokens: 30,
            output_tokens: 200,
            cache_read_input_tokens: 10000,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "result",
        content: "Done",
        accounting: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 300,
            cacheWriteTokens: 400,
          },
          context: {
            usedTokens: 12345,
            windowTokens: 1000000,
            remainingTokens: 987655,
          },
          costUsd: 0.00789,
          numTurns: 2,
          stop: { reason: "completed", raw: "end_turn" },
          stopReason: "end_turn",
          durationMs: 50,
          rawUsage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 400,
          },
        },
      });
      expect(
        (messages[0] as { type: "result"; accounting?: { costUsd?: number } }).accounting?.costUsd,
      ).toBeCloseTo(0.00789);
      // No output_tokens_details: the provider reported no reasoning count.
      expect(
        (messages[0] as { type: "result"; accounting?: { usage: Record<string, unknown> } })
          .accounting?.usage,
      ).not.toHaveProperty("reasoningTokens");
    });

    it("reads reasoning tokens from output_tokens_details and maps the stop reason", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "success",
          result: "21",
          usage: {
            input_tokens: 2,
            output_tokens: 63,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 16007,
            output_tokens_details: { thinking_tokens: 60 },
          },
          num_turns: 1,
          stop_reason: "max_tokens",
          terminal_reason: "completed",
          total_cost_usd: 0.1,
          duration_ms: 5,
        },
      ]);

      const session = await new AnthropicProvider().openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages[0]).toMatchObject({
        type: "result",
        accounting: {
          usage: { outputTokens: 63, reasoningTokens: 60 },
          stop: { reason: "max_tokens", raw: "max_tokens" },
          stopReason: "max_tokens",
        },
      });
    });

    it("classifies a prompt that no longer fits the context window", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["Prompt is too long"],
          num_turns: 1,
          stop_reason: null,
          terminal_reason: "prompt_too_long",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const session = await new AnthropicProvider().openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages[0]).toMatchObject({
        type: "error",
        code: "context_window_exceeded",
      });
    });
  });
});
