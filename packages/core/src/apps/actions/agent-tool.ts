// Core's agent tools: each one a declaration beside the operation it calls,
// which core registers in the main process under its full name. How to add
// one: docs/concepts/actions.md#core-agent-tools.

import {
  defineAction,
  type Action,
  type ActionConfig,
  type ActionResult,
  type PreviewPayload,
} from "@rome-os/app-runtime";
import type { z } from "zod";
import { type ActionExecutionStore, actionExecutionContext } from "./context.js";
import { withApprovalPerCall } from "./types.js";

/** The turn a tool runs for: who it acts for, who can read it, and where. */
export type ToolTurn = Pick<ActionExecutionStore, "actor" | "audience" | "channelContext">;

/** What `run` and `approval` get besides their input: the deps their page
 * was handed, and the turn the tool runs for. */
export interface ToolContext<D> {
  deps: D;
  turn: ToolTurn;
}

/** The words of the card the guardian approves a call on. */
export interface ToolApproval {
  title: string;
  summary: string;
}

/** One agent tool as its page declares it. */
export interface AgentToolSpec<D, S extends z.ZodType> {
  /** The full name agents and routines call it by, such as `system:pause_routine`. */
  name: `system:${string}`;
  /** What the agent reads to choose the tool. */
  description: string;
  /** Whether the tool only reads or also changes something. */
  sideEffects: ActionConfig["sideEffects"];
  /** The tool's arguments, each with a `.describe()` the agent reads. An
   *  argument that does not fit answers the agent with what is wrong. */
  input: S;
  /** Present when the guardian approves a call on a card first: the card's
   *  words for the parsed input, or undefined for an input that runs without
   *  approval. A call whose approval throws does not run. */
  approval?: (
    input: z.output<S>,
    context: ToolContext<D>,
  ) => ToolApproval | undefined | Promise<ToolApproval | undefined>;
  /** The operation, once the input fits. Returns plain
   *  data for the agent, or `toolError(...)`. */
  run: (input: z.output<S>, context: ToolContext<D>) => Promise<ToolOutcome>;
}

/** A declared tool, ready to register once its page's deps are known. */
export interface AgentTool<D> {
  readonly name: string;
  readonly sideEffects: ActionConfig["sideEffects"];
  /** The action core registers for this tool. */
  action(deps: D): Action;
}

/** What `run` returns: data the agent reads, or an error. */
export type ToolOutcome = ToolError | Record<string, unknown>;

const OUTCOME = Symbol("agent-tool-outcome");

/** An answer the agent reads as an error. */
export interface ToolError {
  readonly [OUTCOME]: "error";
  readonly error: string;
}

/** An error the agent can act on, such as a thing the input names that does
 * not exist, or a change the operation turns down. Say what to do next. */
export function toolError(message: string): ToolError {
  return { [OUTCOME]: "error", error: message };
}

/** The declaration function for a page's tools, all taking deps `D`:
 *  `const agentTool = agentToolsOf<RoutineToolDeps>()`, then one
 *  `agentTool({...})` per tool. */
export function agentToolsOf<D>() {
  return <S extends z.ZodType>(spec: AgentToolSpec<D, S>): AgentTool<D> => ({
    name: spec.name,
    sideEffects: spec.sideEffects,
    action: (deps) => toolAction(spec, deps),
  });
}

function toolAction<D, S extends z.ZodType>(spec: AgentToolSpec<D, S>, deps: D): Action {
  const config: ActionConfig = {
    name: spec.name,
    type: "system",
    description: spec.description,
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: spec.sideEffects,
    ...(spec.approval ? { requiresApproval: true } : {}),
  };
  const action = defineAction({
    config,
    schema: spec.input,
    execute: async (input) => resultOf(await spec.run(input, { deps, turn: runningTurn() })),
  });
  const approval = spec.approval;
  if (!approval) return action;
  // The engine reads the preview to decide each call: no card, no approval.
  return withApprovalPerCall({
    ...action,
    preview: async (args): Promise<PreviewPayload | undefined> => {
      const parsed = spec.input.safeParse(args);
      // An input that does not fit runs to the error `execute` answers it
      // with, which runs nothing.
      if (!parsed.success) return undefined;
      const words = await approval(parsed.data, { deps, turn: runningTurn() });
      return words ? { kind: "generic", ...words } : undefined;
    },
  });
}

function resultOf(outcome: ToolOutcome): ActionResult {
  if (OUTCOME in outcome) return { status: "error", error: (outcome as ToolError).error };
  return { status: "ok", data: outcome };
}

/** The turn of the running action, as the engine put it in the action's store. */
export function runningTurn(): ToolTurn {
  const store = actionExecutionContext.getStore();
  return {
    ...(store?.actor ? { actor: store.actor } : {}),
    ...(store?.audience ? { audience: store.audience } : {}),
    ...(store?.channelContext ? { channelContext: store.channelContext } : {}),
  };
}
