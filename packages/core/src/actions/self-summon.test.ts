import { afterEach, describe, expect, it } from "@rstest/core";
import { getCurrentActionContext, type CurrentActionContext } from "@rome-os/app-runtime";
import type { RomeAppContext } from "@rome-os/app-runtime";
import { createSummonAction } from "../../../../rome_apps/system/src/actions/summon/index.js";
import { createCodingTaskAction } from "../../../../rome_apps/coding/src/actions/coding-task/index.js";
import type { AgentRunner } from "../core/agent-runner.js";
import { buildAgentConfig } from "../test/helpers.js";
import {
  buildAction,
  createTestRome,
  invokeAction,
  result,
  type TestRome,
} from "../test/kit/index.js";
import { callAction } from "./call-action.js";
import type { Action, ActionResult } from "./types.js";

// An agent must not start another copy of itself through `system:summon`, whether
// it calls summon directly or through an action of its own app that wraps summon
// (`coding:coding_task`). These tests run the real engine, so the context the
// guard reads (`agentName`, `callerAppId`) is the one the engine really carries.

const summonConfig = {
  name: "system:summon",
  type: "system",
  description: "Summon subagent",
  complexity: "complex",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
} as const;

const SHORT_NAMES: Record<string, string> = {
  coding: "coding:coding",
  assistant: "assistant:assistant",
  main: "core:main",
};
const resolveArtifactReference = ({ value }: { value: string }) => SHORT_NAMES[value] ?? value;

/** A runner that records which agents were started and finishes at once. */
function recordingRunner(started: string[]): AgentRunner {
  return {
    async *run(params: { agentName: string }) {
      started.push(params.agentName);
      yield {
        type: "session_init" as const,
        sessionId: "child-session",
        romeSession: { _romeSessionId: "action:exec-1:child", _type: "action" },
      };
      yield { type: "result" as const, content: "child done" };
    },
  } as unknown as AgentRunner;
}

/** An app-context stand-in whose `runAction` is the real seam: `callAction` with `callerAppId`. */
function appContextOf(appId: string): RomeAppContext {
  return {
    runAction: (name: string, args: Record<string, unknown>) =>
      callAction(name === "summon" ? "system:summon" : name, args, { callerAppId: appId }),
  } as unknown as RomeAppContext;
}

/** An action of `appId` that does some work, then summons `agentName` — not a pass-through. */
function summoningStep(name: string, appId: string, agentName: string): Action {
  const appContext = appContextOf(appId);
  return buildAction(name, {
    execute: async () =>
      (await appContext.runAction("summon", { agentName, prompt: "do it" })) as ActionResult,
  });
}

describe("agents never start a copy of themselves", () => {
  let rome: TestRome;
  let started: string[];

  afterEach(async () => {
    await rome?.cleanup();
  });

  async function setup(extraActions: Action[] = []) {
    started = [];
    const summon = createSummonAction(summonConfig, {
      agentRunner: recordingRunner(started),
      resolveArtifactReference,
    });
    const codingTask = createCodingTaskAction(
      { ...summonConfig, name: "coding:coding_task", type: "custom" },
      { appContext: appContextOf("coding") },
    );
    rome = await createTestRome({ actions: [summon, codingTask, ...extraActions] });
  }

  const asAgent = (agentName: string) => ({
    initiator: `agent:${agentName}`,
    agentName,
  });

  const prompt = "fix the failing test";

  describe("what the engine context holds", () => {
    it("names the calling agent at every hop and marks only the wrapper hop with its app", async () => {
      const seen: Record<string, CurrentActionContext | undefined> = {};
      const probe = (name: string) =>
        buildAction(name, {
          execute: async () => {
            seen[name] = getCurrentActionContext();
            return { status: "ok" };
          },
        });
      const appContext = appContextOf("coding");
      const wrapper = buildAction("coding:wrapper", {
        execute: async () => (await appContext.runAction("probe_inner", {})) as ActionResult,
      });
      await setup([probe("probe_direct"), probe("probe_inner"), wrapper]);

      await rome.actionEngine.run("probe_direct", {}, asAgent("coding:coding"));
      await rome.actionEngine.run("coding:wrapper", {}, asAgent("coding:coding"));

      // Agent calls the action itself: its qualified name, no calling app, no parent.
      expect(seen.probe_direct).toMatchObject({
        agentName: "coding:coding",
        callerAppId: undefined,
        parentActionName: undefined,
      });
      // Agent calls a wrapper that calls the action: the agent name is inherited,
      // and `callerAppId` is the wrapper's app, set for this hop only.
      expect(seen.probe_inner).toMatchObject({
        agentName: "coding:coding",
        callerAppId: "coding",
        parentActionName: "coding:wrapper",
      });
    });

    it("carries no agent for a run that no agent started", async () => {
      let seen: CurrentActionContext | undefined;
      await setup([
        buildAction("probe", {
          execute: async () => {
            seen = getCurrentActionContext();
            return { status: "ok" };
          },
        }),
      ]);

      await rome.actionEngine.run("probe", {}, { initiator: "routine:daily" });

      expect(seen?.agentName).toBeUndefined();
    });

    it("gives a real agent turn's tool call the agent's qualified name", async () => {
      let seen: CurrentActionContext | undefined;
      rome = await createTestRome({
        actions: [
          buildAction("probe", {
            execute: async () => {
              seen = getCurrentActionContext();
              return { status: "ok" };
            },
          }),
        ],
      });
      rome.model.queueReply(invokeAction("probe"), result("done"));

      await rome.runAgent({ prompt: "probe", agentName: "main" });

      expect(seen).toMatchObject({ agentName: "core:main", callerAppId: undefined });
    });
  });

  describe("refuses", () => {
    it("an agent that calls summon itself for its own agent", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "system:summon",
        { agentName: "coding", prompt },
        asAgent("coding:coding"),
      );

      expect(outcome).toEqual({
        status: "error",
        error:
          'You are already the "coding:coding" agent. Do this work yourself instead of ' +
          'starting another "coding:coding" agent.',
      });
      expect(started).toEqual([]);
    });

    it("the same agent named by its qualified id, with the caller named by its short name", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "system:summon",
        { agentName: "coding:coding", prompt },
        asAgent("coding"),
      );

      expect(outcome.status).toBe("error");
      expect(started).toEqual([]);
    });

    it("an interactive handoff to the calling agent", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "system:summon",
        { agentName: "coding", prompt, interactive: true, appId: "coding" },
        asAgent("coding:coding"),
      );

      expect(outcome.status).toBe("error");
    });

    it("an agent that goes through coding_task for its own agent", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "coding:coding_task",
        { prompt },
        asAgent("coding:coding"),
      );

      expect(outcome.status).toBe("error");
      expect((outcome as { error: string }).error).toContain(
        'You are already the "coding:coding" agent.',
      );
      expect(started).toEqual([]);
    });

    it("a real agent turn that calls summon for itself, and lets the agent finish", async () => {
      started = [];
      const summon = createSummonAction(summonConfig, {
        get agentRunner() {
          return rome.agentRunner;
        },
        resolveArtifactReference: ({ value }) => rome.agentLoader.getCanonicalName(value),
      });
      rome = await createTestRome({ actions: [summon] });
      rome.model.queueReply(
        invokeAction("system:summon", { agentName: "main", prompt }),
        result("I did it myself."),
      );

      const messages = await rome.runAgent({ prompt: "fix it", agentName: "main" });

      const toolResult = messages.find((m) => m.type === "tool_result") as {
        output: { status?: string; error?: string };
      };
      expect(toolResult.output.error ?? JSON.stringify(toolResult.output)).toContain(
        'You are already the "core:main" agent.',
      );
      // One model turn only: no second `main` agent started.
      expect(rome.model.calls).toHaveLength(1);
      expect(messages.find((m) => m.type === "result")).toMatchObject({
        content: "I did it myself.",
      });
    });
  });

  describe("allows", () => {
    it("an agent that summons a different agent", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "system:summon",
        { agentName: "assistant", prompt },
        asAgent("coding:coding"),
      );

      expect(outcome.status).toBe("ok");
      expect(started).toEqual(["assistant:assistant"]);
    });

    it("a run that no agent started, directly and through coding_task", async () => {
      await setup();
      const routine = { initiator: "routine:nightly" };

      const direct = await rome.actionEngine.run(
        "system:summon",
        { agentName: "coding", prompt },
        routine,
      );
      const wrapped = await rome.actionEngine.run("coding:coding_task", { prompt }, routine);

      expect(direct.status).toBe("ok");
      expect(wrapped.status).toBe("ok");
      expect(started).toEqual(["coding:coding", "coding:coding"]);
    });

    it("a run started by a user or an app", async () => {
      await setup();

      const outcome = await rome.actionEngine.run(
        "coding:coding_task",
        { prompt },
        { initiator: "app:briefing", callerAppId: "briefing" },
      );

      expect(outcome.status).toBe("ok");
    });

    it("an action of another app that starts the calling agent as one step of its own work", async () => {
      // `briefing:run_brief` starts `assistant`, and `assistant` may run it.
      await setup([summoningStep("briefing:run_brief", "briefing", "assistant")]);

      const outcome = await rome.actionEngine.run(
        "briefing:run_brief",
        {},
        asAgent("assistant:assistant"),
      );

      expect(outcome.status).toBe("ok");
      expect(started).toEqual(["assistant:assistant"]);
    });

    it("a workflow of another app that starts the main agent", async () => {
      await setup([summoningStep("morning-recap:run", "morning-recap", "main")]);

      const outcome = await rome.actionEngine.run("morning-recap:run", {}, asAgent("core:main"));

      expect(outcome.status).toBe("ok");
      expect(started).toEqual(["core:main"]);
    });
  });
});
