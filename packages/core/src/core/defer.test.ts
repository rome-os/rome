import { describe, expect, it, rs } from "@rstest/core";
import { RESUME_SESSION_ACTION, parseDeferInput, runDefer, type DeferContext } from "./defer.js";

// A fixed "now" on a minute boundary keeps the ceil math easy to reason about.
const NOW = Date.parse("2026-06-25T12:00:00.000Z");

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

describe("parseDeferInput", () => {
  it("requires a non-empty name", () => {
    expect(parseDeferInput({ afterMinutes: 5 }, NOW).ok).toBe(false);
    // whitespace-only is trimmed to empty and rejected
    expect(parseDeferInput({ name: "   ", afterMinutes: 5 }, NOW).ok).toBe(false);
  });

  it("trims the name", () => {
    const r = parseDeferInput({ name: "  check CI  ", afterMinutes: 5 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("check CI");
  });

  it("requires exactly one of afterMinutes/at", () => {
    expect(parseDeferInput({ name: "x" }, NOW).ok).toBe(false);
    expect(
      parseDeferInput({ name: "x", afterMinutes: 5, at: "2026-06-25T13:00:00Z" }, NOW).ok,
    ).toBe(false);
  });

  it("rejects a non-positive or non-integer afterMinutes", () => {
    expect(parseDeferInput({ name: "x", afterMinutes: 0 }, NOW).ok).toBe(false);
    expect(parseDeferInput({ name: "x", afterMinutes: -5 }, NOW).ok).toBe(false);
    expect(parseDeferInput({ name: "x", afterMinutes: 1.5 }, NOW).ok).toBe(false);
  });

  it("resolves afterMinutes to an absolute minute-aligned instant", () => {
    const r = parseDeferInput({ name: "check CI", afterMinutes: 5 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("check CI");
      expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T12:05:00.000Z");
    }
  });

  it("ceils to the next whole minute when now is mid-minute (never the past)", () => {
    // now at :30s, afterMinutes 1 -> raw 12:01:30 -> ceil -> 12:02:00.
    const now = Date.parse("2026-06-25T12:00:30.000Z");
    const r = parseDeferInput({ name: "x", afterMinutes: 1 }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T12:02:00.000Z");
  });

  it("accepts an absolute ISO instant", () => {
    const r = parseDeferInput({ name: "x", at: "2026-06-25T18:30:00Z" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T18:30:00.000Z");
  });

  it("rejects an at-instant in the past", () => {
    expect(parseDeferInput({ name: "x", at: "2020-01-01T00:00:00Z" }, NOW).ok).toBe(false);
  });

  it("rejects an unparseable at-instant", () => {
    expect(parseDeferInput({ name: "x", at: "tomorrow" }, NOW).ok).toBe(false);
  });
});

describe("runDefer", () => {
  it("creates a one-off UTC routine targeting the dispatcher", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-1" });
    const result = await runDefer(
      { name: "检查 GitHub CI", afterMinutes: 5 },
      { context: baseContext, createRoutine, now: NOW },
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
  });

  it("throws on a missing thread context", async () => {
    const createRoutine = rs.fn();
    await expect(
      runDefer(
        { name: "x", afterMinutes: 5 },
        {
          context: {
            agentName: "main",
            sessionId: "agent-session-1",
          },
          createRoutine,
          now: NOW,
        },
      ),
    ).rejects.toThrow(/active conversation thread/);
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("propagates a create_routine domain error", async () => {
    const createRoutine = rs.fn().mockRejectedValue(new Error("boom"));
    await expect(
      runDefer({ name: "x", afterMinutes: 5 }, { context: baseContext, createRoutine, now: NOW }),
    ).rejects.toThrow("boom");
  });

  it("carries the channel coords from channelContext into the resume args", async () => {
    const createRoutine = rs.fn().mockResolvedValue({ routineId: "r-2" });
    await runDefer(
      { name: "watch deploy", afterMinutes: 1 },
      {
        context: {
          agentName: "main",
          sessionId: "agent-session-tg-9",
          channelContext: { channel: "telegram", threadId: "tg-9" },
        },
        createRoutine,
        now: NOW,
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
  });
});
