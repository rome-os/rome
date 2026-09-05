import { describe, it, expect, rs } from "@rstest/core";
import type { ActionConfig, ActionResult, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createDailyReportAction, type DailyReportDeps } from "./index.js";

const actionConfig = {
  name: "daily_report",
  type: "custom",
  description: "Daily summary of the Engineer bot's work",
  complexity: "moderate",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
} as unknown as ActionConfig;

const CONFIG_ARGS = {
  repo: "acme/widgets",
  label: "bot",
  projectPath: "/projects/widgets",
};

function makeDeps(
  messages: Array<{ type: string; content?: string; error?: string }>,
  runAction?: (name: string, args: Record<string, unknown>) => Promise<ActionResult>,
): {
  deps: AppActionRuntimeDeps<DailyReportDeps>;
  run: ReturnType<typeof rs.fn>;
  runAction: ReturnType<typeof rs.fn>;
} {
  const run = rs.fn(async function* () {
    for (const msg of messages) yield msg;
  });
  const mockRunAction = rs.fn(
    runAction ?? (async () => ({ status: "ok", data: { sessionId: "s1" } }) as ActionResult),
  );
  return {
    deps: {
      agentRunner: { run },
      appContext: { runAction: mockRunAction },
    } as unknown as AppActionRuntimeDeps<DailyReportDeps>,
    run,
    runAction: mockRunAction,
  };
}

describe("engineer:daily_report", () => {
  it("posts the report into a chat with the Engineer agent", async () => {
    const { deps, run, runAction } = makeDeps([{ type: "result", content: "2 ready, 1 stuck." }]);
    const action = createDailyReportAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ sessionId: "s1", report: "2 ready, 1 stuck." });
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith("system:send_user_message", {
      text: "2 ready, 1 stuck.",
      agentName: "engineer:engineer",
      sessionName: "Engineer daily report",
    });

    const prompt = (run.mock.calls[0] as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("engineer:ready");
    expect(prompt).toContain("engineer:stuck");
    expect(prompt).toContain("merged since yesterday");
    expect(prompt).toContain("<!-- engineer stopped child=<sessionId> issue=<n> -->");
  });

  it("reports the failure when the message is declined", async () => {
    const { deps } = makeDeps([{ type: "result", content: "all quiet" }], async () => ({
      status: "error",
      error: "unknown agent",
    }));
    const action = createDailyReportAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("unknown agent");
  });

  it("reports the failure when sending throws", async () => {
    const { deps } = makeDeps([{ type: "result", content: "all quiet" }], async () => {
      throw new Error("action worker died");
    });
    const action = createDailyReportAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("action worker died");
  });

  it("does not deliver an empty report", async () => {
    const { deps, runAction } = makeDeps([{ type: "result", content: "   " }]);
    const action = createDailyReportAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    expect(result.status).toBe("error");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("refuses to run before setup has stored a config", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "x" }]);
    const action = createDailyReportAction(actionConfig, deps);

    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("engineer:setup");
    expect(run).not.toHaveBeenCalled();
  });
});
