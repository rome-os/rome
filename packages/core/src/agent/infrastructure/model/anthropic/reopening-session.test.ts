import { describe, expect, it, rs } from "@rstest/core";
import type {
  ModelSessionEvent,
  ModelSessionParams,
  ThreadStart,
} from "../../../domain/model-port.js";
import { noRomeTools } from "../../../../test/tool-calls.js";
import { createReopeningSession, type ClaudeQuerySession } from "./reopening-session.js";

interface FakeQuery extends ClaudeQuerySession {
  emit(event: ModelSessionEvent): void;
  fail(error: Error): void;
  finish(): void;
  readonly sent: string[];
  readonly interrupts: number;
}

function fakeQuery(modelThreadId?: string): FakeQuery {
  const queue: Array<ModelSessionEvent | Error | null> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let interrupts = 0;
  const sent: string[] = [];
  const push = (item: ModelSessionEvent | Error | null) => {
    queue.push(item);
    wake?.();
  };
  return {
    providerId: "anthropic",
    model: "claude-test",
    modelThreadId,
    sent,
    get interrupts() {
      return interrupts;
    },
    get ended() {
      return ended;
    },
    events: (async function* () {
      for (;;) {
        while (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const item = queue.shift();
        if (item === null || item === undefined) return;
        if (item instanceof Error) throw item;
        yield item;
      }
    })(),
    async sendUserInput(input) {
      sent.push(input.text ?? "");
    },
    async steerUserInput() {
      return "accepted";
    },
    async interrupt() {
      interrupts++;
      ended = true;
    },
    async close() {
      ended = true;
      push(null);
    },
    emit: push,
    fail(error) {
      ended = true;
      push(error);
    },
    finish() {
      ended = true;
      push(null);
    },
  };
}

function setup(first: FakeQuery, thread: ThreadStart = { kind: "new" }) {
  const params: ModelSessionParams = {
    config: { model: "claude-test", systemPrompt: "system", builtinTools: [] },
    tools: noRomeTools(),
    thread,
  };
  const reopened: FakeQuery[] = [];
  const open = rs.fn(async (_params: ModelSessionParams) => {
    const next = fakeQuery(
      _params.thread.kind === "resume" ? _params.thread.modelThreadId : undefined,
    );
    reopened.push(next);
    return next;
  });
  const session = createReopeningSession({ params, first, open, reasoningEffort: "high" });
  return { session, open, reopened, events: session.events[Symbol.asyncIterator]() };
}

describe("createReopeningSession", () => {
  it("keeps one stream and resumes the thread on the input after an interrupt", async () => {
    const first = fakeQuery("thread-1");
    const { session, open, reopened, events } = setup(first);

    await session.sendUserInput({ text: "first" });
    await session.interrupt("user-stop");
    first.emit({ type: "result", content: "partial", reasoningEffort: "high" });
    await expect(events.next()).resolves.toMatchObject({ value: { content: "partial" } });
    first.finish();

    const parked = events.next();
    await session.sendUserInput({ text: "second" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0].thread).toEqual({ kind: "resume", modelThreadId: "thread-1" });
    expect(reopened[0]?.sent).toEqual(["second"]);
    reopened[0]?.emit({ type: "result", content: "next", reasoningEffort: "high" });
    await expect(parked).resolves.toMatchObject({ value: { content: "next" } });
    expect(session.modelThreadId).toBe("thread-1");
    await session.close();
  });

  it("opens the first thread again when the interrupted query never named one", async () => {
    const first = fakeQuery();
    const { session, open, events } = setup(first);

    await session.sendUserInput({ text: "first" });
    await session.interrupt();
    first.finish();
    await expect(events.next()).resolves.toMatchObject({ value: { type: "result", content: "" } });
    const parked = events.next();

    await session.sendUserInput({ text: "second" });
    expect(open.mock.calls[0]?.[0].thread).toEqual({ kind: "new" });
    await session.close();
    await parked;
  });

  it("ends an interrupted turn whose query stopped without a terminal", async () => {
    const first = fakeQuery("thread-1");
    const { session, events } = setup(first);

    await session.sendUserInput({ text: "first" });
    await session.interrupt();
    first.finish();

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "result", content: "", reasoningEffort: "high" },
    });
    await session.close();
  });

  it("fails an open turn when the query's stream ends or throws", async () => {
    const ended = fakeQuery("thread-1");
    const endedCase = setup(ended);
    await endedCase.session.sendUserInput({ text: "first" });
    ended.finish();
    await expect(endedCase.events.next()).resolves.toMatchObject({
      value: { type: "error", error: "session closed mid-turn" },
    });
    await endedCase.session.close();

    const thrown = fakeQuery("thread-1");
    const thrownCase = setup(thrown);
    await thrownCase.session.sendUserInput({ text: "first" });
    thrown.fail(new Error("process exited"));
    await expect(thrownCase.events.next()).resolves.toMatchObject({
      value: { type: "error", error: "process exited" },
    });
    await thrownCase.session.close();
  });

  it("reopens after a query ended between turns", async () => {
    const first = fakeQuery("thread-1");
    const { session, open, reopened, events } = setup(first);
    const parked = events.next();
    first.finish();

    await session.sendUserInput({ text: "next" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(reopened[0]?.sent).toEqual(["next"]);
    await session.close();
    await parked;
  });

  it("surfaces a failed reopen to the input and tries again on the next one", async () => {
    const first = fakeQuery("thread-1");
    const { session, open, events } = setup(first);
    const parked = events.next();
    first.finish();

    open.mockRejectedValueOnce(new Error("no credentials"));
    await expect(session.sendUserInput({ text: "next" })).rejects.toThrow("no credentials");
    await session.sendUserInput({ text: "retry" });
    expect(open).toHaveBeenCalledTimes(2);
    await session.close();
    await parked;
  });

  it("defers a steer once the query has ended and rejects input after close", async () => {
    const first = fakeQuery("thread-1");
    const { session, events } = setup(first);
    const parked = events.next();
    await expect(session.steerUserInput?.({ text: "more", inputId: "i1" })).resolves.toBe(
      "accepted",
    );
    await session.interrupt();
    await expect(session.steerUserInput?.({ text: "more", inputId: "i2" })).resolves.toBe(
      "deferred",
    );

    await session.close();
    await parked;
    await expect(session.sendUserInput({ text: "late" })).rejects.toThrow("closed");
  });

  it("does not interrupt a query that has already ended", async () => {
    const first = fakeQuery("thread-1");
    const { session, events } = setup(first);
    const parked = events.next();
    await session.interrupt();
    await session.interrupt();
    expect(first.interrupts).toBe(1);
    await session.close();
    await parked;
  });
});
