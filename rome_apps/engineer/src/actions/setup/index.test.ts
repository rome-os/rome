import { describe, it, expect, rs } from "@rstest/core";
import type { ActionConfig, ActionResult, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { toRoutineArgs, type EngineerConfig } from "../../lib/config.js";
import { dailyTrigger, tickTrigger } from "../../lib/interval.js";
import {
  createSetupAction,
  originMatchesRepo,
  type CommandResult,
  type SetupSeams,
} from "./index.js";

const actionConfig = {
  name: "setup",
  type: "custom",
  description: "Point the Engineer bot at a repository",
  complexity: "moderate",
  speed: "moderate",
  reliability: "high",
  sideEffects: "write",
} as unknown as ActionConfig;

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const ORIGIN: CommandResult = {
  code: 0,
  stdout: "https://github.com/acme/widgets.git\n",
  stderr: "",
};

const DEFAULT_CONFIG: EngineerConfig = {
  repo: "acme/widgets",
  label: "engineer",
  projectPath: "/projects/acme-widgets",
  tickMinutes: 30,
  reportLocalTime: "08:00",
  maxNewTasksPerTick: 1,
  maxActiveChildren: 3,
  maxResumesPerIssue: 3,
  maxChildAgeHours: 3,
  maxIssuesPerTick: 20,
};

interface Harness {
  deps: AppActionRuntimeDeps;
  seams: SetupSeams;
  runAction: ReturnType<typeof rs.fn>;
  listRoutines: ReturnType<typeof rs.fn>;
  run: ReturnType<typeof rs.fn>;
}

/** Every create reports an id derived from the key, so a test can name the routine a later delete targets. */
function routineIdFor(key: unknown): string {
  return `new-${String(key)}`;
}

function makeHarness(overrides?: {
  runAction?: (name: string, args: Record<string, unknown>) => Promise<ActionResult>;
  routines?: Array<Record<string, unknown>>;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
  directoryExists?: (path: string) => Promise<boolean>;
}): Harness {
  const runAction = rs.fn(
    overrides?.runAction ??
      (async (name: string, args: Record<string, unknown>) =>
        (name === "system:create_routine"
          ? { status: "ok", data: { routineId: routineIdFor(args.key) } }
          : { status: "ok" }) as ActionResult),
  );
  const listRoutines = rs.fn(async () => overrides?.routines ?? []);
  const run = rs.fn(
    overrides?.run ??
      (async (command: string, args: string[]) =>
        command === "git" && args[0] === "-C" ? ORIGIN : OK),
  );

  return {
    deps: { appContext: { runAction, listRoutines } } as unknown as AppActionRuntimeDeps,
    seams: {
      run: run as unknown as SetupSeams["run"],
      directoryExists: overrides?.directoryExists ?? (async () => true),
      ensureParentDir: async () => {},
      projectsRoot: () => "/projects",
    },
    runAction,
    listRoutines,
    run,
  };
}

function createdRoutine(runAction: Harness["runAction"], key: string): Record<string, unknown> {
  const call = runAction.mock.calls.find(
    ([name, args]: [string, Record<string, unknown>]) =>
      name === "system:create_routine" && args.key === key,
  );
  if (!call) throw new Error(`no create_routine call for key "${key}"`);
  return call[1] as Record<string, unknown>;
}

/** The routine calls in order, as `create <key>` / `delete <routineId>`. */
function routineCalls(runAction: Harness["runAction"]): string[] {
  return runAction.mock.calls
    .filter(([name]: [string]) => name.startsWith("system:") && name.endsWith("_routine"))
    .map(([name, args]: [string, Record<string, unknown>]) =>
      name === "system:create_routine" ? `create ${args.key}` : `delete ${args.routineId}`,
    );
}

/** A routine already registered at the spec the action would write. */
function liveTickRoutine(): Record<string, unknown> {
  return {
    id: "r1",
    key: "engineer-tick",
    name: "Engineer: reconcile GitHub",
    actionName: "engineer:tick",
    trigger: { ...tickTrigger(30) },
    args: toRoutineArgs(DEFAULT_CONFIG),
  };
}

function liveReportRoutine(): Record<string, unknown> {
  return {
    id: "r2",
    key: "engineer-daily-report",
    name: "Engineer: daily report",
    actionName: "engineer:daily_report",
    trigger: { ...dailyTrigger("08:00") },
    args: toRoutineArgs(DEFAULT_CONFIG),
  };
}

describe("engineer:setup", () => {
  it("registers both routines with the full config in args", async () => {
    const h = makeHarness();
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject(DEFAULT_CONFIG);

    const tick = createdRoutine(h.runAction, "engineer-tick");
    expect(tick.actionName).toBe("engineer:tick");
    expect(tick.name).toBe("Engineer: reconcile GitHub");
    expect(tick.trigger).toMatchObject({
      type: "schedule",
      tzMode: "floating",
      rrule: "FREQ=MINUTELY;INTERVAL=30",
    });
    expect(tick.args).toEqual(DEFAULT_CONFIG);

    const report = createdRoutine(h.runAction, "engineer-daily-report");
    expect(report.actionName).toBe("engineer:daily_report");
    expect(report.name).toBe("Engineer: daily report");
    expect(report.trigger).toMatchObject({ localTime: "08:00", rrule: "FREQ=DAILY" });
    expect(report.args).toEqual(tick.args);
  });

  it("honors caller-supplied config and clean-cron snapping", async () => {
    const h = makeHarness();
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({
      repo: "acme/widgets",
      label: "bot",
      projectPath: "/srv/widgets",
      tickMinutes: 47,
      reportLocalTime: "07:15",
      maxNewTasksPerTick: 2,
      maxActiveChildren: 5,
      maxResumesPerIssue: 4,
      maxChildAgeHours: 6,
      maxIssuesPerTick: 40,
    });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({
      label: "bot",
      projectPath: "/srv/widgets",
      // 47 is not a clean cron cadence; it snaps to the nearest one that is.
      tickMinutes: 60,
      reportLocalTime: "07:15",
      maxNewTasksPerTick: 2,
      maxActiveChildren: 5,
      maxResumesPerIssue: 4,
      maxChildAgeHours: 6,
      maxIssuesPerTick: 40,
    });
    expect(createdRoutine(h.runAction, "engineer-tick").trigger).toMatchObject({
      rrule: "FREQ=HOURLY;INTERVAL=1",
    });
  });

  it("leaves a routine that already holds the spec untouched", async () => {
    const h = makeHarness({ routines: [liveTickRoutine(), liveReportRoutine()] });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({
      routines: { "engineer-tick": "unchanged", "engineer-daily-report": "unchanged" },
    });
    expect(routineCalls(h.runAction)).toEqual([]);
  });

  it("stages the replacement before deleting the routine it replaces", async () => {
    const h = makeHarness({
      routines: [{ ...liveTickRoutine(), args: { repo: "acme/widgets" } }, liveReportRoutine()],
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({
      routines: { "engineer-tick": "replaced", "engineer-daily-report": "unchanged" },
    });
    // The new routine exists before the old one is deleted, so no moment of the
    // swap has zero tick routines.
    expect(routineCalls(h.runAction)).toEqual([
      "create engineer-tick-staging",
      "delete r1",
      "create engineer-tick",
      "delete new-engineer-tick-staging",
    ]);
  });

  it("keeps the old routine when the delete is refused for an active run", async () => {
    const h = makeHarness({
      routines: [{ ...liveTickRoutine(), args: { repo: "acme/widgets" } }, liveReportRoutine()],
      runAction: async (name, args) => {
        if (name === "system:create_routine") {
          return { status: "ok", data: { routineId: routineIdFor(args.key) } };
        }
        if (name === "system:delete_routine" && args.routineId === "r1") {
          return { status: "error", error: 'Routine "r1" has 1 active run(s)' };
        }
        return { status: "ok" };
      },
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("active run");
    // The staged twin is dropped, so the refused swap leaves exactly one tick
    // routine: the one that was already there.
    expect(routineCalls(h.runAction)).toEqual([
      "create engineer-tick-staging",
      "delete r1",
      "delete new-engineer-tick-staging",
    ]);
  });

  it("keeps the old routine when the replacement cannot be created", async () => {
    const h = makeHarness({
      routines: [{ ...liveTickRoutine(), args: { repo: "acme/widgets" } }],
      runAction: async (name) =>
        name === "system:create_routine"
          ? { status: "error", error: "bad trigger" }
          : { status: "ok" },
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("bad trigger");
    expect(routineCalls(h.runAction)).toEqual(["create engineer-tick-staging"]);
  });

  it("leaves the staged routine running when the final create fails", async () => {
    const h = makeHarness({
      routines: [{ ...liveTickRoutine(), args: { repo: "acme/widgets" } }],
      runAction: async (name, args) => {
        if (name === "system:create_routine") {
          return args.key === "engineer-tick"
            ? { status: "error", error: "key taken" }
            : { status: "ok", data: { routineId: routineIdFor(args.key) } };
        }
        return { status: "ok" };
      },
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("key taken");
    expect(result.error).toContain("engineer:setup");
    // The staging routine is the only one left, so the schedule keeps firing.
    expect(routineCalls(h.runAction)).toEqual([
      "create engineer-tick-staging",
      "delete r1",
      "create engineer-tick",
    ]);
  });

  it("drops a staged routine an interrupted run left behind", async () => {
    const h = makeHarness({
      routines: [
        liveTickRoutine(),
        { ...liveTickRoutine(), id: "leftover", key: "engineer-tick-staging" },
        liveReportRoutine(),
      ],
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(routineCalls(h.runAction)).toEqual(["delete leftover"]);
  });

  it("creates a routine whose key is free, even with a routine of the same name", async () => {
    const h = makeHarness({
      routines: [{ id: "other", name: "Engineer: reconcile GitHub" }],
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    await action.execute({ repo: "acme/widgets" });

    // Dedup is on the key, not the display name — a routine that merely shares
    // the name is not ours to delete.
    expect(h.runAction).not.toHaveBeenCalledWith("system:delete_routine", expect.anything());
    expect(createdRoutine(h.runAction, "engineer-tick")).toBeDefined();
  });

  it("tells the guardian to connect GitHub when gh is unauthenticated", async () => {
    const h = makeHarness({
      run: async (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" };
        }
        return command === "git" && args[0] === "-C" ? ORIGIN : OK;
      },
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("/settings");
    expect(h.runAction).not.toHaveBeenCalled();
  });

  it("clones into an owner-qualified directory under the projects root", async () => {
    const h = makeHarness({ directoryExists: async () => false });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ cloned: true, projectPath: "/projects/acme-widgets" });
    expect(h.run).toHaveBeenCalledWith("git", [
      "clone",
      "https://github.com/acme/widgets",
      "/projects/acme-widgets",
    ]);
  });

  it("reuses a directory whose origin is this repository", async () => {
    const h = makeHarness();
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ cloned: false });
    expect(h.run).toHaveBeenCalledWith("git", [
      "-C",
      "/projects/acme-widgets",
      "remote",
      "get-url",
      "origin",
    ]);
  });

  it("refuses a directory that is a clone of another repository", async () => {
    const h = makeHarness({
      run: async (command, args) =>
        command === "git" && args[0] === "-C"
          ? { code: 0, stdout: "git@github.com:other/widgets.git\n", stderr: "" }
          : OK,
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets", projectPath: "/srv/elsewhere" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("other/widgets");
    expect(result.error).toContain("acme/widgets");
    expect(h.runAction).not.toHaveBeenCalled();
  });

  it("refuses a directory that is not a clone at all", async () => {
    const h = makeHarness({
      run: async (command, args) =>
        command === "git" && args[0] === "-C"
          ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
          : OK,
    });
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "acme/widgets", projectPath: "/srv/notes" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("not a git repository");
    expect(h.runAction).not.toHaveBeenCalled();
  });

  it("creates the task label and both status labels", async () => {
    const h = makeHarness();
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    await action.execute({ repo: "acme/widgets" });

    const labelNames = h.run.mock.calls
      .filter(([command, args]: [string, string[]]) => command === "gh" && args[0] === "label")
      .map(([, args]: [string, string[]]) => args[2]);
    expect(labelNames).toEqual(["engineer", "engineer:stuck", "engineer:ready"]);
  });

  it("rejects a repo that is not owner/name", async () => {
    const h = makeHarness();
    const action = createSetupAction(actionConfig, h.deps, h.seams);

    const result = await action.execute({ repo: "https://github.com/acme/widgets" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("owner/name");
  });
});

describe("originMatchesRepo", () => {
  it("accepts every url form git writes for the same repository", () => {
    for (const url of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
      "https://x-access-token:secret@github.com/acme/widgets.git",
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://github.com/ACME/Widgets.git",
    ]) {
      expect(originMatchesRepo(url, "acme/widgets")).toBe(true);
    }
  });

  it("rejects another repository, another owner, and a local path", () => {
    for (const url of [
      "https://github.com/acme/gadgets.git",
      "git@github.com:other/widgets.git",
      "/srv/mirrors/acme/widgets",
      "",
    ]) {
      expect(originMatchesRepo(url, "acme/widgets")).toBe(false);
    }
  });
});
