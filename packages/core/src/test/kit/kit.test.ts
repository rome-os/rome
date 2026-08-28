import { describe, it, expect, afterEach } from "@rstest/core";
import {
  createTestRome,
  recordingAction,
  installTestClock,
  parseDuration,
  text,
  result,
  invokeAction,
  FakeClock,
  type TestRome,
  type TestClock,
} from "./index.js";

describe("testkit", () => {
  let rome: TestRome | undefined;
  let clock: TestClock | undefined;

  afterEach(async () => {
    clock?.uninstall();
    clock = undefined;
    await rome?.cleanup();
    rome = undefined;
  });

  describe("createTestRome + FakeModel", () => {
    it("runs an agent turn through the real session stack and persists the session", async () => {
      rome = await createTestRome();
      rome.model
        .whenPromptIncludes("weather")
        .reply(text("Checking…"), result("It's sunny in Rome."));

      const messages = await rome.runAgent({
        prompt: "what's the weather?",
        channelThreadKey: "telegram:thread-7",
      });

      const resultMsg = messages.find((m) => m.type === "result");
      expect(resultMsg).toMatchObject({ content: "It's sunny in Rome." });

      // The REAL SessionManager persisted the session row.
      const init = messages.find((m) => m.type === "session_init");
      expect(init).toBeDefined();
      const session = await rome.repos.sessions.findById((init as { sessionId: string }).sessionId);
      expect(session).not.toBeNull();
      expect(session!.agentName).toBe("main");
      expect(session!.channelThreadKey).toBe("telegram:thread-7");

      // The model saw the real PromptBuilder output for the "main" agent.
      expect(rome.model.lastSystemPrompt()).toContain("You are a test agent.");
    });

    it("invokeAction steps execute registered actions through the real engine", async () => {
      const sendMessage = recordingAction("send_message", {
        execute: async (args) => ({ status: "ok", data: { delivered: args.to } }),
      });
      rome = await createTestRome({ actions: [sendMessage.action] });
      rome.model.queueReply(
        invokeAction("send_message", { to: "user-1", body: "hi" }),
        result("Sent."),
      );

      const messages = await rome.runAgent({ prompt: "send hi to user-1" });

      // The action really executed — not a stub assertion.
      expect(sendMessage.calls).toEqual([{ to: "user-1", body: "hi" }]);

      // The real engine recorded the execution in the DB.
      const executions = await rome.repos.actionExecutions.findByAction("send_message");
      expect(executions).toHaveLength(1);

      // The model stream carried the real tool_use/tool_result pair.
      const toolResult = messages.find((m) => m.type === "tool_result");
      expect(toolResult).toBeDefined();
    });

    it("surfaces invokeAction failures as error tool_results instead of killing the session", async () => {
      rome = await createTestRome();
      rome.model.queueReply(
        invokeAction("not_registered", {}),
        result("Recovered after tool error."),
      );

      // The turn completes — the rejection must not escape the fake session.
      const messages = await rome.runAgent({ prompt: "try the tool" });

      const toolResult = messages.find((m) => m.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect((toolResult as { output: { error?: string } }).output.error).toMatch(/not_registered/);
      expect(messages.find((m) => m.type === "result")).toMatchObject({
        content: "Recovered after tool error.",
      });
    });

    it("builds the production system prompt by default, and a bare one with repoView 'empty'", async () => {
      rome = await createTestRome();
      await rome.runAgent({ prompt: "hi" });
      // Real repo roots: PromptBuilder picked up the repo's CHARTER.md.
      expect(rome.model.lastSystemPrompt()).toContain("# Charter");
      await rome.cleanup();

      rome = await createTestRome({ repoView: "empty" });
      await rome.runAgent({ prompt: "hi" });
      expect(rome.model.lastSystemPrompt()).not.toContain("# Charter");
    });

    it("queued replies are consumed FIFO, then falls back to the default reply", async () => {
      rome = await createTestRome();
      rome.model.queueReply(result("first"));

      const first = await rome.runAgent({ prompt: "one", channelThreadKey: "webchat:a" });
      const second = await rome.runAgent({ prompt: "two", channelThreadKey: "webchat:b" });

      expect(first.find((m) => m.type === "result")).toMatchObject({ content: "first" });
      expect(second.find((m) => m.type === "result")).toMatchObject({ content: "OK" });
      expect(rome.model.prompts()).toEqual(["one", "two"]);
    });
  });

  describe("harness isolation", () => {
    it("scopes profile-backed paths into the temp sandbox and restores env on cleanup", async () => {
      const homeBefore = process.env.HOME;
      const profileBefore = process.env.ROME_PROFILE;

      rome = await createTestRome();

      // All profile-backed writes resolve under the sandbox, not the real ~/.rome.
      const { getProfileDir } = await import("../../paths.js");
      expect(getProfileDir()).toContain("rome-testkit-");
      expect(getProfileDir()).toBe(`${process.env.HOME}/.rome/${process.env.ROME_PROFILE}`);

      await rome.cleanup();
      await rome.cleanup(); // idempotent
      expect(process.env.HOME).toBe(homeBefore);
      expect(process.env.ROME_PROFILE).toBe(profileBefore);
      rome = undefined;
    });

    it("fails fast when a second harness is created before cleanup", async () => {
      rome = await createTestRome();

      await expect(createTestRome()).rejects.toThrow(/another harness is already active/);

      // The failed attempt must not have clobbered the active harness's env.
      expect(process.env.HOME).toContain("rome-testkit-");

      await rome.cleanup();
      rome = undefined;

      // After cleanup the slot frees up again.
      rome = await createTestRome();
    });
  });

  describe("FakeChannelEndpoint", () => {
    it("drives a request/reply round trip through the adapter seam", async () => {
      rome = await createTestRome({ channels: ["telegram"] });
      const tg = rome.channel("telegram");

      // Stand-in for the inbox pipeline (system-app hook) until the kit can
      // boot it: anything that consumes onMessage and replies via the adapter.
      tg.onMessage(async (msg) => {
        await tg.sendMessage(msg.channelUserId, msg.threadId, {
          text: `echo: ${msg.text}`,
        });
      });

      await tg.send({ text: "hello", threadId: "t-1", channelUserId: "u-1" });

      const reply = await tg.nextReply();
      expect(reply).toMatchObject({
        channelUserId: "u-1",
        threadId: "t-1",
        message: { text: "echo: hello" },
      });
    });

    it("nextReply times out instead of hanging when no reply arrives", async () => {
      rome = await createTestRome({ channels: ["telegram"] });
      await expect(rome.channel("telegram").nextReply({ timeoutMs: 30 })).rejects.toThrow(
        /No reply on channel "telegram"/,
      );
    });
  });

  describe("TestClock", () => {
    it("parses human durations", () => {
      expect(parseDuration(1500)).toBe(1500);
      expect(parseDuration("150ms")).toBe(150);
      expect(parseDuration("30s")).toBe(30_000);
      expect(parseDuration("5m")).toBe(300_000);
      expect(parseDuration("2h")).toBe(7_200_000);
      expect(() => parseDuration("soon")).toThrow(/Unparseable duration/);
    });

    it("advances timers deterministically", async () => {
      clock = installTestClock(new Date("2026-01-15T10:00:00Z"));
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, parseDuration("5m"));

      await clock.advance("4m");
      expect(fired).toBe(false);
      await clock.advance("1m");
      expect(fired).toBe(true);
      expect(clock.now().toISOString()).toBe("2026-01-15T10:05:00.000Z");
    });
  });

  describe("FakeClock", () => {
    it("fires timers only when advanced past their delay, in schedule order", async () => {
      const fake = new FakeClock(new Date("2026-01-15T10:00:00Z"));
      const fired: string[] = [];
      fake.setTimeout(() => fired.push("late"), parseDuration("5m"));
      fake.setTimeout(() => fired.push("early"), parseDuration("1m"));

      await fake.advance("30s");
      expect(fired).toEqual([]);

      await fake.advance("10m");
      expect(fired).toEqual(["early", "late"]);
      expect(fake.now().toISOString()).toBe("2026-01-15T10:10:30.000Z");
      expect(fake.pendingTimerCount()).toBe(0);
    });

    it("a cleared timer never fires", async () => {
      const fake = new FakeClock();
      let fired = false;
      const timer = fake.setTimeout(() => {
        fired = true;
      }, 1_000);
      fake.clearTimeout(timer);

      await fake.advance("2s");
      expect(fired).toBe(false);
    });

    it("a timer's callback can schedule a follow-up that fires within the same advance", async () => {
      const fake = new FakeClock();
      const fired: string[] = [];
      fake.setTimeout(() => {
        fired.push("first");
        fake.setTimeout(() => fired.push("second"), 1_000);
      }, 1_000);

      await fake.advance("2s");
      expect(fired).toEqual(["first", "second"]);
    });

    it("settles async work started by a fired timer before advance resolves", async () => {
      const fake = new FakeClock();
      let settled = false;
      fake.setTimeout(() => {
        void Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => {
            settled = true;
          });
      }, 1_000);

      await fake.advance("1s");
      expect(settled).toBe(true);
    });

    it("never touches global timers", async () => {
      const fake = new FakeClock();
      const before = Date.now();
      await fake.advance("1h");
      expect(Date.now() - before).toBeLessThan(parseDuration("5s"));
    });
  });
});
