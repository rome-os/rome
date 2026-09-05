import { describe, it, expect, rs } from "@rstest/core";
import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { toRoutineArgs, type EngineerConfig } from "../../lib/config.js";
import { dailyTrigger, tickTrigger } from "../../lib/interval.js";
import { createConfigAction } from "./index.js";

const actionConfig = {
  name: "config",
  type: "custom",
  description: "Read the Engineer bot's current configuration",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as unknown as ActionConfig;

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

function tickRoutine(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r1",
    key: "engineer-tick",
    name: "Engineer: reconcile GitHub",
    actionName: "engineer:tick",
    trigger: { ...tickTrigger(30) },
    args,
  };
}

function reportRoutine(): Record<string, unknown> {
  return {
    id: "r2",
    key: "engineer-daily-report",
    name: "Engineer: daily report",
    actionName: "engineer:daily_report",
    trigger: { ...dailyTrigger("08:00") },
    args: toRoutineArgs(DEFAULT_CONFIG),
  };
}

function makeDeps(routines: Array<Record<string, unknown>>): AppActionRuntimeDeps {
  return {
    appContext: { listRoutines: rs.fn(async () => routines) },
  } as unknown as AppActionRuntimeDeps;
}

describe("engineer:config", () => {
  it("reads the configuration back out of the tick routine", async () => {
    const action = createConfigAction(
      actionConfig,
      makeDeps([tickRoutine(toRoutineArgs(DEFAULT_CONFIG)), reportRoutine()]),
    );

    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toEqual({ configured: true, ...DEFAULT_CONFIG });
  });

  it("fills the defaults the routine args leave out", async () => {
    const action = createConfigAction(
      actionConfig,
      makeDeps([
        tickRoutine({
          repo: "acme/widgets",
          projectPath: "/srv/widgets",
          maxActiveChildren: 5,
          __triggerPayload: { firedAt: "2026-01-01T00:00:00.000Z" },
        }),
      ]),
    );

    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toEqual({
      ...DEFAULT_CONFIG,
      configured: true,
      projectPath: "/srv/widgets",
      maxActiveChildren: 5,
    });
  });

  it("reports no configuration when no routine is registered", async () => {
    const action = createConfigAction(actionConfig, makeDeps([]));

    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toEqual({ configured: false });
  });

  it("reports no configuration when only the daily-report routine exists", async () => {
    // The report routine carries the same args, but a config no tick runs on is
    // not a configured bot.
    const action = createConfigAction(actionConfig, makeDeps([reportRoutine()]));

    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toEqual({ configured: false });
  });

  it("reports no configuration when the tick routine names no repository", async () => {
    const action = createConfigAction(
      actionConfig,
      makeDeps([tickRoutine({ label: "bot", projectPath: "/srv/widgets" })]),
    );

    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ configured: false });
    expect((result.data as { reason?: string }).reason).toContain("owner/name");
  });
});
