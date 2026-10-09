import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { type Peer, PeerServer, type VisibleMessage } from "./peer.js";
import { runScenario } from "./scenario.js";
import type { TestChannel } from "./test-channel.js";
import { TRACE_META_KEY, traceSchema } from "./trace.js";

const CONVERSATION = "chat-1" as ConversationId;

describe("runScenario", () => {
  let directory: string;
  let server: PeerServer;
  let shown: VisibleMessage[];
  let channel: TestChannel;
  let meta: Record<string, unknown>;

  const post = (path: string) =>
    server.fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

  const task = () => ({ id: "file > telegram > a test", meta });

  const readTrace = async () => {
    const file = meta[TRACE_META_KEY];
    if (typeof file !== "string") throw new Error("The scenario named no trace");
    return traceSchema.parse(JSON.parse(await readFile(file, "utf8")));
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "scenario-traces-"));
    process.env.ROME_CHANNEL_TRACES = directory;
    meta = {};
    shown = [];
    server = await new PeerServer(({ path }) =>
      path === "/messages" ? { body: { ok: true }, source: "capture", accepted: true } : undefined,
    ).start();
    const peer: Peer = {
      server,
      visible: (conversation) => shown.filter((message) => message.conversation === conversation),
      close: () => server.close(),
    };
    channel = {
      platform: "telegram",
      peer,
      conversation: CONVERSATION,
      send: () => Promise.reject(new Error("Not used")),
      receive: () => Promise.reject(new Error("Not used")),
      stop: () => Promise.resolve(),
    };
  });

  afterEach(async () => {
    delete process.env.ROME_CHANNEL_TRACES;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records each step with what the conversation shows, and the requests after it started", async () => {
    // Answered before the scenario began, so it belongs to the channel's setup.
    await post("/messages");

    await runScenario(task(), channel, async ({ step }) => {
      await step("The user writes", async () => {
        await post("/messages");
        shown = [
          { id: "1", conversation: CONVERSATION, from: "user", text: "hello", edits: 0 },
          { id: "9", conversation: "elsewhere", from: "user", text: "other", edits: 0 },
        ];
      });
    });

    const trace = await readTrace();
    expect(trace).toMatchObject({ platform: "telegram", conversation: CONVERSATION });
    expect(trace.steps).toEqual([
      {
        label: "The user writes",
        status: "passed",
        startedAt: expect.any(Number),
        durationMs: expect.any(Number),
        visible: [{ id: "1", conversation: CONVERSATION, from: "user", text: "hello", edits: 0 }],
      },
    ]);
    expect(trace.exchanges).toHaveLength(1);
    expect(trace.exchanges[0]).toMatchObject({
      method: "POST",
      path: "/messages",
      requestBody: { text: "hi" },
      status: 200,
      responseBody: { ok: true },
      source: "capture",
      accepted: true,
    });
    // One clock: the request came in during the step that made it.
    const [step] = trace.steps;
    expect(trace.exchanges[0]?.receivedAt).toBeGreaterThanOrEqual(step?.startedAt ?? Infinity);
    expect(trace.exchanges[0]?.answeredAt).toBeLessThanOrEqual(
      (step?.startedAt ?? 0) + (step?.durationMs ?? 0),
    );
  });

  it("names the failing step in the error, and records it with the original message", async () => {
    await expect(
      runScenario(task(), channel, async ({ step }) => {
        await step("Rome answers", () => {
          throw new Error("boom");
        });
      }),
    ).rejects.toThrow('Step "Rome answers": boom');

    expect((await readTrace()).steps).toMatchObject([
      { label: "Rome answers", status: "failed", error: "boom" },
    ]);
  });

  it("writes the trace of a scenario whose body fails outside a step", async () => {
    await expect(
      runScenario(task(), channel, async ({ step }) => {
        await step("The user writes", () => {});
        throw new Error("assertion outside a step");
      }),
    ).rejects.toThrow("assertion outside a step");

    expect((await readTrace()).steps).toMatchObject([{ label: "The user writes" }]);
  });

  describe("when the trace cannot be written", () => {
    beforeEach(async () => {
      // A directory cannot be made under a file.
      await writeFile(join(directory, "blocker"), "");
      process.env.ROME_CHANNEL_TRACES = join(directory, "blocker", "traces");
    });

    it("still reports why the scenario failed", async () => {
      await expect(
        runScenario(task(), channel, async ({ step }) => {
          await step("Rome answers", () => {
            throw new Error("boom");
          });
        }),
      ).rejects.toThrow('Step "Rome answers": boom');
    });

    it("fails a scenario that passed, since its trace is missing", async () => {
      await expect(runScenario(task(), channel, async () => {})).rejects.toThrow(/ENOTDIR/);
    });
  });

  it("records nothing unless a trace directory is named", async () => {
    delete process.env.ROME_CHANNEL_TRACES;

    await runScenario(task(), channel, async ({ step }) => {
      await step("The user writes", () => {});
    });

    expect(meta).toEqual({});
  });
});
