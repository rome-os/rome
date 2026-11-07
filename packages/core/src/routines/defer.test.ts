import { describe, expect, it, rs } from "@rstest/core";
import { RESUME_SESSION_ACTION, runDefer, type DeferContext } from "./defer.js";

// A fixed "now" on a minute boundary keeps the ceil math easy to reason about.
const NOW = Date.parse("2026-06-25T12:00:00.000Z");
const MINUTE_MS = 60_000;

const threadContext = {
  channel: "webchat",
  threadId: "sess-1",
  channelUserId: "guardian-1",
  threadName: "Guardian",
};

const baseContext: DeferContext = {
  agentName: "main",
  sessionId: "agent-session-1",
  channelContext: threadContext,
};

describe("runDefer", () => {
  it("creates a once event-bus routine for an event wait", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-ev" });
    const result = await runDefer(
      {
        kind: "event",
        name: "CI on #12",
        event: {
          eventName: "github.check_suite",
          filter: [{ field: "pr", equals: "12" }],
        },
      },
      { context: baseContext, createRoutine },
    );

    expect(result).toEqual({
      ok: true,
      name: "CI on #12",
      waitingFor: "github.check_suite",
      routineId: "r-ev",
    });
    const args = createRoutine.mock.calls[0][0];
    expect(args.name).toBe("CI on #12");
    expect(args.actionName).toBe(RESUME_SESSION_ACTION);
    expect(args.trigger).toEqual({
      type: "event-bus",
      eventName: "github.check_suite",
      filter: [{ field: "pr", equals: "12" }],
      once: true,
    });
    expect(args.args).toMatchObject({
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      channelUserId: "guardian-1",
      agentName: "main",
      text: "📨 Event arrived: CI on #12",
      attachEvent: true,
    });
  });

  it("subscribes through the event source before it creates the wait", async () => {
    const calls: string[] = [];
    const prepareEventWait = rs.fn(async () => {
      calls.push("prepare");
      return { ok: true as const, subscription: "created" as const };
    });
    const createRoutine = rs.fn(async () => {
      calls.push("create");
      return { routineId: "r-ev" };
    });
    const filter = [{ field: "repository.full_name", equals: "acme/widgets" }];
    const result = await runDefer(
      {
        kind: "event",
        name: "CI",
        event: { eventName: "provider:event:github.workflow_run", filter },
      },
      { context: baseContext, createRoutine, prepareEventWait },
    );

    expect(calls).toEqual(["prepare", "create"]);
    expect(prepareEventWait).toHaveBeenCalledWith("provider:event:github.workflow_run", filter);
    expect(result).toEqual({
      ok: true,
      name: "CI",
      waitingFor: "provider:event:github.workflow_run",
      subscription: "created",
      routineId: "r-ev",
    });
  });

  it("creates no wait when the event source refuses", async () => {
    const createRoutine = rs.fn();
    const prepareEventWait = rs.fn(async () => ({
      ok: false as const,
      error: "GitHub refused the webhook on acme/widgets",
    }));
    await expect(
      runDefer(
        { kind: "event", name: "CI", event: { eventName: "provider:event:github.workflow_run" } },
        { context: baseContext, createRoutine, prepareEventWait },
      ),
    ).rejects.toThrow("GitHub refused the webhook on acme/widgets");
    expect(prepareEventWait).toHaveBeenCalledWith("provider:event:github.workflow_run", []);
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("creates the wait and passes on a warning from the event source", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-w" });
    const prepareEventWait = rs.fn(async () => ({
      ok: true as const,
      warning: "Nothing has emitted it since Rome started",
    }));
    const result = await runDefer(
      { kind: "event", name: "reply", event: { eventName: "provider:event:gmail.new_message" } },
      { context: baseContext, createRoutine, prepareEventWait },
    );
    expect(createRoutine).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      warning: "Nothing has emitted it since Rome started",
    });
  });

  it("does not ask the event source for a time wakeup", async () => {
    const prepareEventWait = rs.fn();
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-t" });
    await runDefer(
      { kind: "time", name: "x", fireAtMs: NOW + 5 * MINUTE_MS },
      { context: baseContext, createRoutine, prepareEventWait },
    );
    expect(prepareEventWait).not.toHaveBeenCalled();
  });

  it("creates a one-off UTC routine targeting the dispatcher", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-1" });
    const result = await runDefer(
      { kind: "time", name: "检查 GitHub CI", fireAtMs: NOW + 5 * MINUTE_MS },
      { context: baseContext, createRoutine },
    );

    expect(result).toMatchObject({
      ok: true,
      name: "检查 GitHub CI",
      deferredUntil: "2026-06-25T12:05:00.000Z",
      routineId: "r-1",
    });

    expect(createRoutine).toHaveBeenCalledTimes(1);
    const args = createRoutine.mock.calls[0][0];
    expect(args.actionName).toBe(RESUME_SESSION_ACTION);
    expect(args.trigger).toMatchObject({
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      date: "2026-06-25",
      localTime: "12:05",
    });
    expect(args.trigger.rrule).toBeUndefined();
    expect(args.args).toMatchObject({
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      channelUserId: "guardian-1",
      agentName: "main",
    });
    expect(args.args).not.toHaveProperty("channelThreadKey");
    // Continuations carry no inbound-trust fields — those belong to inbound only.
    expect(args.args.bondLevel).toBeUndefined();
    expect(args.args.routedAgentName).toBeUndefined();
    // The agent-supplied name is the routine name; the wakeup prompt is a simple
    // time's-up nudge that just references it (the woken agent has full context).
    expect(args.name).toBe("检查 GitHub CI");
    expect(args.args.text).toBe("⏰ Time's up: 检查 GitHub CI");
    expect(args.args).not.toHaveProperty("messageId");
    expect(args.args).not.toHaveProperty("attachEvent");
  });

  it("throws on a missing thread context", async () => {
    const createRoutine = rs.fn();
    await expect(
      runDefer(
        { kind: "time", name: "x", fireAtMs: NOW + 5 * MINUTE_MS },
        {
          context: {
            agentName: "main",
            sessionId: "agent-session-1",
          },
          createRoutine,
        },
      ),
    ).rejects.toThrow(/active conversation thread/);
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("propagates a create_routine domain error", async () => {
    const createRoutine = rs.fn().mockRejectedValue(new Error("boom"));
    await expect(
      runDefer(
        { kind: "time", name: "x", fireAtMs: NOW + 5 * MINUTE_MS },
        { context: baseContext, createRoutine },
      ),
    ).rejects.toThrow("boom");
  });

  it("carries the channel coords from channelContext into the resume args", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-2" });
    await runDefer(
      { kind: "time", name: "watch deploy", fireAtMs: NOW + 1 * MINUTE_MS },
      {
        context: {
          agentName: "main",
          sessionId: "agent-session-tg-9",
          channelContext: { channel: "telegram", threadId: "tg-9" },
        },
        createRoutine,
      },
    );
    const args = createRoutine.mock.calls[0][0];
    expect(args.name).toBe("watch deploy");
    expect(args.args).toMatchObject({
      sessionId: "agent-session-tg-9",
      channel: "telegram",
      threadId: "tg-9",
      agentName: "main",
    });
    expect(args.args).not.toHaveProperty("channelThreadKey");
    expect(args.args.text).toBe("⏰ Time's up: watch deploy");
    expect(args.args).not.toHaveProperty("ownerKey");
  });

  it("records whose chat it was scheduled in, so the wake-up reaches them after the chat is gone", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-3" });
    await runDefer(
      { kind: "time", name: "check back", fireAtMs: NOW + 5 * MINUTE_MS },
      { context: { ...baseContext, ownerKey: "visitor:a" }, createRoutine },
    );
    expect(createRoutine.mock.calls[0][0].args).toMatchObject({ ownerKey: "visitor:a" });
  });
});
