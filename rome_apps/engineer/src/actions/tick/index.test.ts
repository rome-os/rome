import { describe, it, expect, rs } from "@rstest/core";
import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createTickAction, type TickDeps } from "./index.js";

const actionConfig = {
  name: "tick",
  type: "custom",
  description: "One reconciliation pass",
  complexity: "complex",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
} as unknown as ActionConfig;

const CONFIG_ARGS = {
  repo: "acme/widgets",
  label: "bot",
  projectPath: "/projects/widgets",
  tickMinutes: 30,
  reportLocalTime: "08:00",
  maxNewTasksPerTick: 2,
  maxActiveChildren: 4,
  maxResumesPerIssue: 5,
  maxChildAgeHours: 6,
  maxIssuesPerTick: 7,
};

function makeDeps(messages: Array<{ type: string; content?: string; error?: string }>): {
  deps: AppActionRuntimeDeps<TickDeps>;
  run: ReturnType<typeof rs.fn>;
} {
  const run = rs.fn(async function* () {
    for (const msg of messages) yield msg;
  });
  return {
    deps: { agentRunner: { run }, appContext: {} } as unknown as AppActionRuntimeDeps<TickDeps>,
    run,
  };
}

function promptFor(run: ReturnType<typeof rs.fn>): string {
  const call = run.mock.calls[0] as [{ agentName: string; prompt: string }];
  return call[0].prompt;
}

describe("engineer:tick", () => {
  it("runs the engineer agent with the config from the routine args", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "Touched #4." }]);
    const action = createTickAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ repo: "acme/widgets", summary: "Touched #4." });

    const call = run.mock.calls[0] as [{ agentName: string }];
    expect(call[0].agentName).toBe("engineer:engineer");

    const prompt = promptFor(run);
    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("/projects/widgets");
    expect(prompt).toContain("bot");
  });

  it("carries every cap into the prompt", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    await action.execute({ ...CONFIG_ARGS });

    const prompt = promptFor(run);
    expect(prompt).toContain("maxNewTasksPerTick: 2");
    expect(prompt).toContain("maxActiveChildren: 4");
    expect(prompt).toContain("maxResumesPerIssue: 5");
    expect(prompt).toContain("maxChildAgeHours: 6");
    expect(prompt).toContain("maxIssuesPerTick: 7");
    expect(prompt).toContain("start at most 2 this tick");
    expect(prompt).toContain("fewer than 4 children are running");
    expect(prompt).toContain("at most 7 of them this tick");
    expect(prompt).toContain("older than 6 hours");
    expect(prompt).toContain("above 5");
  });

  it("starts new children before it reads or steers anything", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    await action.execute({ ...CONFIG_ARGS });

    const prompt = promptFor(run);
    const steps = [
      "a. Read the state",
      "b. Start new children",
      "c. Act on the statuses",
      "d. Steer",
      "e. End the turn",
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = prompt.indexOf(step);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("carries the working directory into the start call", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    await action.execute({ ...CONFIG_ARGS });

    expect(promptFor(run)).toContain(
      'system:summon { agentName: "coding:coding", prompt: "<the brief>", detached: true, workingDir: "/projects/widgets" }',
    );
  });

  it("carries all three markers, the branch shape and the resume rules", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    await action.execute({ ...CONFIG_ARGS });

    const prompt = promptFor(run);
    expect(prompt).toContain("<!-- engineer child=<sessionId> issue=<n> -->");
    expect(prompt).toContain(
      "<!-- engineer resume child=<sessionId> issue=<n> attempt=<k> reason=<failed|interrupted|no-pr|ci|review|conflict> -->",
    );
    expect(prompt).toContain("sha=<headRefOid>");
    expect(prompt).toContain("<!-- engineer stopped child=<sessionId> issue=<n> -->");
    expect(prompt).toContain("engineer/issue-<n>-<slug>");
    expect(prompt).toContain("system:summon_status");
    expect(prompt).toContain("system:summon_stop");
    expect(prompt).toContain("headRefOid equals the sha");
    expect(prompt).toContain("child is still running");
    expect(prompt).toContain("engineer:stuck");
    expect(prompt).toContain("engineer:ready");
    expect(prompt).toContain("Never merge");
  });

  it("refuses to run when the routine args carry no repository", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    const result = await action.execute({ projectPath: "/projects/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("engineer:setup");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to run when the clone path is not absolute", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    const result = await action.execute({ repo: "acme/widgets", projectPath: "widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("projectPath");
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the default caps when the routine args omit them", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    await action.execute({ repo: "acme/widgets", projectPath: "/projects/widgets" });

    const prompt = promptFor(run);
    expect(prompt).toContain("maxResumesPerIssue: 3");
    expect(prompt).toContain("maxChildAgeHours: 3");
    expect(prompt).toContain("maxIssuesPerTick: 20");
  });

  it("surfaces an agent error", async () => {
    const { deps } = makeDeps([{ type: "error", error: "model timeout" }]);
    const action = createTickAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("model timeout");
  });

  it("ignores the trigger payload the routine engine merges into args", async () => {
    const { deps, run } = makeDeps([{ type: "result", content: "done" }]);
    const action = createTickAction(actionConfig, deps);

    const result = await action.execute({ ...CONFIG_ARGS, __triggerPayload: { firedAt: "now" } });

    expect(result.status).toBe("ok");
    expect(promptFor(run)).toContain("acme/widgets");
  });
});
