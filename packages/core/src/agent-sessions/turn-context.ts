// What a caller sets on the OTel context `sendTurn` is called in, for the turn
// to read once: facts about where the call came from, not options of the turn.

import type { CurrentActionContext } from "@rome-os/app-runtime";
import { context, createContextKey, type Link } from "@opentelemetry/api";

/** Links the per-turn root span takes. */
export const TURN_LINKS = createContextKey("rome.agent-turn.links");

/** The execution a turn runs under when that execution runs in another
 *  process. */
export const TURN_EXECUTION = createContextKey("rome.agent-turn.execution");

/** Runs `fn` with `links` on the context, so a turn it sends links to them
 *  without making them its parent. */
export function withTurnLinks<T>(links: Link[] | undefined, fn: () => T): T {
  return links?.length ? context.with(context.active().setValue(TURN_LINKS, links), fn) : fn();
}

/** Runs `fn` with `execution` on the context, so a turn it sends runs under
 *  it as though it ran in this process. Tools the turn calls are unaffected. */
export function withTurnExecution<T>(execution: CurrentActionContext | undefined, fn: () => T): T {
  return execution ? context.with(context.active().setValue(TURN_EXECUTION, execution), fn) : fn();
}
