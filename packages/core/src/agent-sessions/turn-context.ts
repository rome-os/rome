// What a caller sets on the async context `sendTurn` is called in, for the turn
// to read once: facts about where the call came from, not options of the turn.
// They ride their own AsyncLocalStorage, not the OTel context, so they reach
// the turn whether or not telemetry installed a context manager.

import { AsyncLocalStorage } from "node:async_hooks";
import type { CurrentActionContext } from "@rome-os/app-runtime";
import type { Link } from "@opentelemetry/api";

interface TurnFacts {
  /** Links the per-turn root span takes. */
  links?: Link[];
  /** The execution a turn runs under when that execution runs in another
   *  process. */
  execution?: CurrentActionContext;
}

const facts = new AsyncLocalStorage<TurnFacts>();

/** What the caller of the turn being sent set, read when it is sent. */
export function turnFacts(): TurnFacts {
  return facts.getStore() ?? {};
}

/** Runs `fn` with `links` set, so a turn it sends links to them without
 *  making them its parent. */
export function withTurnLinks<T>(links: Link[] | undefined, fn: () => T): T {
  return links?.length ? facts.run({ ...facts.getStore(), links }, fn) : fn();
}

/** Runs `fn` with `execution` set, so a turn it sends runs under it as though
 *  it ran in this process. Tools the turn calls are unaffected. */
export function withTurnExecution<T>(execution: CurrentActionContext | undefined, fn: () => T): T {
  return execution ? facts.run({ ...facts.getStore(), execution }, fn) : fn();
}

/** Runs `fn` with no turn facts set, so the work of a turn already sent, and
 *  any turn its tools send, does not take the facts its caller set. */
export function outsideTurnFacts<T>(fn: () => T): T {
  return facts.exit(fn);
}
