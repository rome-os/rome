import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { trace, type Attributes } from "@opentelemetry/api";
import type { Logger } from "../logger.js";

export interface HookIdentity {
  hookType: "lifecycle" | "webhook" | string;
  appId: string;
  hookName: string;
}

export interface HookInvocationContext {
  rootInvocationId: string;
  depth: number;
  chain: HookIdentity[];
}

export type HookSkipReason = "max_hook_depth" | "max_same_hook_depth";

export interface HookInvocationAllowed {
  allowed: true;
  identity: HookIdentity;
  parentContext: HookInvocationContext;
  nextContext: HookInvocationContext;
  sameHookCount: number;
}

export interface HookInvocationSkipped {
  allowed: false;
  identity: HookIdentity;
  parentContext: HookInvocationContext;
  nextContext: HookInvocationContext;
  sameHookCount: number;
  reason: HookSkipReason;
}

export type HookInvocationDecision = HookInvocationAllowed | HookInvocationSkipped;

export interface HookDispatchResult {
  invoked: number;
  skipped: number;
  skips: HookInvocationSkipped[];
}

const MAX_HOOK_DEPTH = 4;
const MAX_SAME_HOOK_DEPTH = 1;

const hookInvocationContext = new AsyncLocalStorage<HookInvocationContext | undefined>();

export function getCurrentHookInvocationContext(): HookInvocationContext | undefined {
  const current = hookInvocationContext.getStore();
  return current ? cloneHookInvocationContext(current) : undefined;
}

export function getCurrentOrCreateHookInvocationContext(): HookInvocationContext {
  return getCurrentHookInvocationContext() ?? createRootHookInvocationContext();
}

export function createRootHookInvocationContext(): HookInvocationContext {
  return {
    rootInvocationId: randomUUID(),
    depth: 0,
    chain: [],
  };
}

export function runWithHookInvocationContext<T>(
  context: HookInvocationContext | undefined,
  fn: () => T,
): T {
  return hookInvocationContext.run(context ? cloneHookInvocationContext(context) : undefined, fn);
}

export function runWithoutHookInvocationContext<T>(fn: () => T): T {
  return hookInvocationContext.run(undefined, fn);
}

export function evaluateHookInvocation(
  parentContext: HookInvocationContext,
  identity: HookIdentity,
): HookInvocationDecision {
  const nextContext: HookInvocationContext = {
    rootInvocationId: parentContext.rootInvocationId,
    depth: parentContext.depth + 1,
    chain: [...parentContext.chain, identity],
  };
  const sameHookCount = countSameHook(nextContext.chain, identity);
  if (nextContext.depth > MAX_HOOK_DEPTH) {
    return {
      allowed: false,
      identity,
      parentContext,
      nextContext,
      sameHookCount,
      reason: "max_hook_depth",
    };
  }
  if (sameHookCount > MAX_SAME_HOOK_DEPTH) {
    return {
      allowed: false,
      identity,
      parentContext,
      nextContext,
      sameHookCount,
      reason: "max_same_hook_depth",
    };
  }
  return {
    allowed: true,
    identity,
    parentContext,
    nextContext,
    sameHookCount,
  };
}

export function createHookDispatchResult(): HookDispatchResult {
  return { invoked: 0, skipped: 0, skips: [] };
}

export function recordHookSkip(logger: Logger, decision: HookInvocationSkipped): void {
  const attrs = hookTelemetryAttrs(decision);
  logger.warn("hook skipped by recursion guard", attrs);
  trace.getActiveSpan()?.addEvent("hook.skipped", attrs);
}

export function hookTelemetryAttrs(decision: HookInvocationDecision): Attributes {
  const attrs: Attributes = {
    "hook.root_invocation_id": decision.nextContext.rootInvocationId,
    "hook.depth": decision.nextContext.depth,
    "hook.max_depth": MAX_HOOK_DEPTH,
    "hook.max_same_hook_depth": MAX_SAME_HOOK_DEPTH,
    "hook.type": decision.identity.hookType,
    "hook.app_id": decision.identity.appId,
    "hook.name": decision.identity.hookName,
    "hook.chain": formatHookChain(decision.nextContext.chain),
    "hook.same_hook_count": decision.sameHookCount,
  };
  if (!decision.allowed) {
    attrs["hook.skip_reason"] = decision.reason;
    attrs["hook.candidate_depth"] = decision.nextContext.depth;
  }
  return attrs;
}

export function formatHookChain(chain: HookIdentity[]): string {
  return chain
    .map((identity) => `${identity.hookType}:${identity.appId}:${identity.hookName}`)
    .join(" > ");
}

function countSameHook(chain: HookIdentity[], identity: HookIdentity): number {
  return chain.filter(
    (entry) =>
      entry.hookType === identity.hookType &&
      entry.appId === identity.appId &&
      entry.hookName === identity.hookName,
  ).length;
}

function cloneHookInvocationContext(context: HookInvocationContext): HookInvocationContext {
  return {
    rootInvocationId: context.rootInvocationId,
    depth: context.depth,
    chain: context.chain.map((entry) => ({ ...entry })),
  };
}
