// Core's agent tools: each one a declaration beside the operation it calls,
// which core registers in the main process under its full name. How to add
// one: docs/concepts/actions.md#core-agent-tools.

import { randomUUID } from "node:crypto";
import {
  defineAction,
  type Action,
  type ActionConfig,
  type ActionResult,
  type PendingInteraction,
  type PreviewPayload,
} from "@rome-os/app-runtime";
import type { z } from "zod";
import { actionExecutionContext } from "./context.js";
import { CallRefusal, withApprovalPerCall } from "./types.js";
import type { ToolTurn, WhoMayAsk } from "./who-may-ask.js";

export type { ToolTurn } from "./who-may-ask.js";

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
  /** Picks who may ask: a read needs a turn that works for the guardian, a
   *  write the guardian's own message in their private chat (who-may-ask.ts). */
  sideEffects: ActionConfig["sideEffects"];
  /** The tool's arguments, each with a `.describe()` the agent reads. An
   *  argument that does not fit answers the agent with what is wrong. */
  input: S;
  /** Present when the guardian approves a call on a card first: the card's
   *  words for the parsed input, or undefined for an input that runs without
   *  approval. Called only for a turn that may ask. A call whose approval
   *  throws does not run. */
  approval?: (
    input: z.output<S>,
    context: ToolContext<D>,
  ) => ToolApproval | undefined | Promise<ToolApproval | undefined>;
  /** The operation, once the turn may ask and the input fits. Returns plain
   *  data for the agent, `card(...)`, or `toolError(...)`. */
  run: (input: z.output<S>, context: ToolContext<D>) => Promise<ToolOutcome>;
}

/** A declared tool, ready to register once its page's deps are known. */
export interface AgentTool<D> {
  readonly name: string;
  readonly sideEffects: ActionConfig["sideEffects"];
  /** The action core registers for this tool. */
  action(deps: D, whoMayAsk: WhoMayAsk): Action;
}

/** What `run` returns: data the agent reads, a card, or an error. */
export type ToolOutcome = ToolCard | ToolError | Record<string, unknown>;

const OUTCOME = Symbol("agent-tool-outcome");

/** A card core draws in the chat, which the agent waits on. */
export interface ToolCard {
  readonly [OUTCOME]: "card";
  readonly interaction: PendingInteraction;
}

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

/** A card of core's own, shown in the chat the tool runs in. The chat draws
 * it only when its entry in `BUILTIN_CARDS` (api/routes/webchat.ts) says so,
 * and only as kept here: the render carries a token this process issued, which
 * the chat claims (`claimToolCard`). `ask` is what the agent says in its place
 * where the chat draws no card. Call it from `run`, once per card shown. */
export function card(spec: {
  componentId: string;
  props: Record<string, unknown>;
  ask: string;
}): ToolCard {
  const kept = { componentId: spec.componentId, props: spec.props };
  const render = {
    kind: "inline",
    ...kept,
    builtin: true,
    cardToken: issueToolCard(kept),
  } as PendingInteraction["render"];
  return { [OUTCOME]: "card", interaction: { appId: "core", promptText: spec.ask, render } };
}

/** A card `card()` kept, as the chat stores it. */
export interface IssuedToolCard {
  componentId: string;
  props: Record<string, unknown>;
}

// Cards core's own tools returned through `card()`, by a token only this
// process issued, with when each lapses. Any tool, such as one on an agent's
// external MCP server named `execute_action`, can print the same output, so
// neither the tool's name nor the action it names proves the card is core's;
// the token does. A token outlives no restart, which only drops a card shown
// across one.
const issuedToolCards = new Map<string, { card: IssuedToolCard; lapses: number }>();
const ISSUED_TOOL_CARD_MS = 30 * 60 * 1000;

function issueToolCard(card: IssuedToolCard, now = Date.now()): string {
  for (const [token, kept] of issuedToolCards) {
    if (kept.lapses <= now) issuedToolCards.delete(token);
  }
  const token = randomUUID();
  issuedToolCards.set(token, { card, lapses: now + ISSUED_TOOL_CARD_MS });
  return token;
}

/** The card a token claims, or null when this process issued no such token,
 *  it lapsed, or it kept a card of another kind. A token claims its card once. */
export function claimToolCard(
  token: unknown,
  componentId: string,
  now = Date.now(),
): IssuedToolCard | null {
  if (typeof token !== "string") return null;
  const kept = issuedToolCards.get(token);
  issuedToolCards.delete(token);
  if (!kept || kept.lapses <= now || kept.card.componentId !== componentId) return null;
  return kept.card;
}

/** The declaration function for a page's tools, all taking deps `D`:
 *  `const agentTool = agentToolsOf<RoutineToolDeps>()`, then one
 *  `agentTool({...})` per tool. */
export function agentToolsOf<D>() {
  return <S extends z.ZodType>(spec: AgentToolSpec<D, S>): AgentTool<D> => ({
    name: spec.name,
    sideEffects: spec.sideEffects,
    action: (deps, whoMayAsk) => toolAction(spec, deps, whoMayAsk),
  });
}

function toolAction<D, S extends z.ZodType>(
  spec: AgentToolSpec<D, S>,
  deps: D,
  whoMayAsk: WhoMayAsk,
): Action {
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
    execute: async (input) => {
      const turn = runningTurn();
      const refusal = await whoMayAsk(spec, turn);
      if (refusal) return { status: "error", error: refusal };
      return resultOf(await spec.run(input, { deps, turn }));
    },
  });
  const approval = spec.approval;
  if (!approval) return action;
  // The engine reads the preview to decide each call: no card, no approval.
  // Who may ask is checked first, so a turn that may not ask ends with its
  // refusal before `approval` reads a dep or the engine records a card.
  return withApprovalPerCall({
    ...action,
    preview: async (args): Promise<PreviewPayload | undefined> => {
      const turn = runningTurn();
      const refusal = await whoMayAsk(spec, turn);
      if (refusal) throw new CallRefusal(refusal);
      const parsed = spec.input.safeParse(args);
      // An input that does not fit runs to the error `execute` answers it
      // with, which runs nothing.
      if (!parsed.success) return undefined;
      const words = await approval(parsed.data, { deps, turn });
      return words ? { kind: "generic", ...words } : undefined;
    },
  });
}

function resultOf(outcome: ToolOutcome): ActionResult {
  if (OUTCOME in outcome) {
    return outcome[OUTCOME] === "card"
      ? { status: "pending_interaction", interaction: (outcome as ToolCard).interaction }
      : { status: "error", error: (outcome as ToolError).error };
  }
  return { status: "ok", data: outcome };
}

/** The turn of the running action, as the engine put it in the action's store. */
function runningTurn(): ToolTurn {
  const store = actionExecutionContext.getStore();
  return {
    ...(store?.actor ? { actor: store.actor } : {}),
    ...(store?.audience ? { audience: store.audience } : {}),
    ...(store?.channelContext ? { channelContext: store.channelContext } : {}),
  };
}
