import { describe, expect, it, rs, afterEach } from "@rstest/core";
import { setCurrentActionContextResolver, type ActionConfig } from "@rome-os/app-runtime";
import { createAction, createSendFeedbackAction, type FeedbackOutcome } from "./index.js";

const config = { name: "send_feedback", type: "system" } as ActionConfig;
const input = { category: "bug", summary: "Broken", details: "Minimal repro" };
function action(outcome: FeedbackOutcome = { kind: "ok" }) {
  const send = rs.fn(async () => outcome);
  return { action: createSendFeedbackAction(config, { feedback: { send } }), send };
}
afterEach(() => setCurrentActionContextResolver(undefined));

describe("send_feedback", () => {
  it("exposes strict input without model-supplied provenance", () => {
    const schema = action().action.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "category",
      "summary",
      "details",
      "subject",
    ]);
  });
  it.each([
    { ...input, reporter: { kind: "guardian" } },
    { ...input, agentName: "spoof" },
    { ...input, sessionId: "spoof" },
    { ...input, turnId: "spoof" },
    { ...input, executionId: "spoof" },
    { ...input, diagnostics: {} },
    { ...input, unknown: true },
    { ...input, category: "invalid" },
    { ...input, summary: "" },
    { ...input, summary: " " },
    { ...input, summary: "x".repeat(161) },
    { ...input, summary: "two\nlines" },
    { ...input, summary: "\nline" },
    { ...input, summary: "two\rline" },
    { ...input, subject: "x".repeat(201) },
    { ...input, details: 4 },
    { ...input, summary: "x", details: "x".repeat(3998) },
  ])("rejects invalid input without dispatch: %j", async (bad) => {
    const { action: a, send } = action();
    expect((await a.execute(bad)).status).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });
  it("allows a composed body exactly 4000 characters long", async () => {
    expect(
      await action().action.execute({ ...input, summary: "x", details: "x".repeat(3997) }),
    ).toEqual({ status: "ok" });
  });
  it("gets provenance only from the runtime action context", async () => {
    setCurrentActionContextResolver(() => ({
      agentName: "main",
      sessionId: "s",
      turnId: "t",
      executionId: "e",
      sharedContext: { private: "never send" },
    }));
    const { action: a, send } = action();
    expect(await a.execute(input)).toEqual({ status: "ok" });
    expect(send).toHaveBeenCalledWith({
      ...input,
      reporter: { kind: "agent", agentName: "main", sessionId: "s", turnId: "t", executionId: "e" },
    });
  });
  it("records the calling app when an installed app invokes the action", async () => {
    setCurrentActionContextResolver(() => ({ executionId: "e", callerAppId: "some-app" }));
    const { action: a, send } = action();
    await a.execute(input);
    expect(send).toHaveBeenCalledWith({
      ...input,
      reporter: { kind: "agent", executionId: "e", callerAppId: "some-app" },
    });
  });
  it.each([
    "no_token",
    "unconfigured",
    "rate_limited",
    "duplicate",
    "disabled",
  ] as const)("maps %s", async (kind) => {
    expect(await action({ kind }).action.execute(input)).toEqual({ status: "error", error: kind });
  });
  it("maps rejection status and marks unreachable outcomes unknown without retry", async () => {
    expect(await action({ kind: "rejected", status: 413, body: {} }).action.execute(input)).toEqual(
      { status: "error", error: "feedback_rejected_413" },
    );
    const { action: a, send } = action({ kind: "unreachable" });
    const result = await a.execute(input);
    expect(result.status).toBe("error");
    expect(result.error).toContain("feedback_outcome_unknown");
    expect(result.error).toContain("Do not retry");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("validates capability shape at load time", () => {
    expect(() => createAction(config, {} as never)).toThrow("requires a feedback capability");
  });
  it("propagates unexpected implementation errors", async () => {
    const a = createSendFeedbackAction(config, {
      feedback: {
        send: async () => {
          throw new Error("bug");
        },
      },
    });
    await expect(a.execute(input)).rejects.toThrow("bug");
  });
});
