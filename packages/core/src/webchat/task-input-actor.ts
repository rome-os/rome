// A task input inherits its admitting turn, not the HTTP scope delivering it.
// Contract: docs/concepts/actions.md#actor.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Account } from "@rome-os/app-runtime";
import { sessionOwnerKey, type SessionActor } from "../access/session-actor.js";
import type { Body } from "../chats/send.js";
import { isConciergeChat, privateOwnerOf, TASK_CHAT_TRIGGER_KIND } from "./privacy.js";
import type { WebChatRepository } from "./repository.js";

export interface TaskInputSource {
  agentName: string;
  chatId: string;
  turnId: string;
  actor: SessionActor;
  /** False after cancellation, a different turn, or mixed-actor input. */
  isCurrent(): boolean;
}

export interface TaskInputClaim {
  readonly source: TaskInputSource;
  readonly target: string;
  readonly body: Body;
  readonly expires: number;
}

const inputs = new AsyncLocalStorage<TaskInputClaim | undefined>();
const states = new WeakMap<
  TaskInputClaim,
  { active: boolean; used: boolean; checked: boolean; authorized: boolean; admitted: boolean }
>();
const HANDOFF_MS = 30_000;

/** One internal send may claim this input while its source turn still owns it. */
export async function withTaskInputActor<T>(
  source: TaskInputSource | undefined,
  target: string,
  body: Body,
  send: () => Promise<T>,
): Promise<T> {
  if (!source) return inputs.run(undefined, send);
  const claim: TaskInputClaim = Object.freeze({
    source: Object.freeze({ ...source, actor: Object.freeze({ ...source.actor }) }),
    target,
    body: Object.freeze({ ...body }),
    expires: Date.now() + HANDOFF_MS,
  });
  const state = { active: true, used: false, checked: false, authorized: false, admitted: false };
  states.set(claim, state);
  try {
    return await inputs.run(claim, send);
  } finally {
    state.active = false;
  }
}

/** A receiver's setup and callbacks must not inherit the sending scope. */
export function withoutTaskInputActor<T>(receive: () => T): T {
  return inputs.run(undefined, receive);
}

function current(claim: TaskInputClaim): boolean {
  return (
    states.get(claim)?.active === true && Date.now() < claim.expires && claim.source.isCurrent()
  );
}

/** Consumes the matching send before any async work. A mismatched or spent send is refused. */
export function claimTaskInputActor(
  target: string,
  body: Body,
  as: Account,
): TaskInputClaim | undefined {
  const claim = inputs.getStore();
  if (!claim) return undefined;
  if (
    states.get(claim)?.used !== false ||
    !current(claim) ||
    claim.source.agentName !== "core:concierge" ||
    as.platform !== "webchat" ||
    as.id !== claim.source.agentName ||
    target !== claim.target ||
    target === claim.source.chatId ||
    body.text !== claim.body.text ||
    body.skillName !== claim.body.skillName
  )
    throw new Error("Task input attribution is unavailable");
  states.get(claim)!.used = true;
  return claim;
}

/** Only the same person's Concierge may hand an input to its private task chat. */
export async function taskInputActor(
  claim: TaskInputClaim,
  repository: Pick<WebChatRepository, "getSession">,
  sourceOfTask: (chatId: string) => Promise<string | null>,
): Promise<SessionActor> {
  const state = states.get(claim);
  if (!state?.used || state.checked || !current(claim))
    throw new Error("Task input attribution is unavailable");
  state.checked = true;
  const actor = await checkTaskInputActor(claim, repository, sourceOfTask);
  state.authorized = true;
  return actor;
}

/** Recheck ownership after async setup, before the one permitted admission. */
export async function refreshTaskInputActor(
  claim: TaskInputClaim,
  repository: Pick<WebChatRepository, "getSession">,
  sourceOfTask: (chatId: string) => Promise<string | null>,
): Promise<SessionActor> {
  assertTaskInputCurrent(claim);
  const state = states.get(claim)!;
  state.authorized = false;
  const actor = await checkTaskInputActor(claim, repository, sourceOfTask);
  state.authorized = true;
  return actor;
}

async function checkTaskInputActor(
  claim: TaskInputClaim,
  repository: Pick<WebChatRepository, "getSession">,
  sourceOfTask: (chatId: string) => Promise<string | null>,
): Promise<SessionActor> {
  const [source, target, origin] = await Promise.all([
    repository.getSession(claim.source.chatId),
    repository.getSession(claim.target),
    sourceOfTask(claim.target),
  ]);
  const owner = sessionOwnerKey(claim.source.actor);
  if (
    !current(claim) ||
    !owner ||
    !source ||
    !target ||
    origin !== claim.source.chatId ||
    !isConciergeChat(source) ||
    target.triggerKind !== TASK_CHAT_TRIGGER_KIND ||
    source.archivedAt !== null ||
    target.archivedAt !== null ||
    privateOwnerOf(source) !== owner ||
    privateOwnerOf(target) !== owner
  )
    throw new Error("Task input attribution is unavailable");
  return claim.source.actor;
}

/** A checked handoff remains revocable until the input is synchronously submitted. */
export function assertTaskInputCurrent(claim: TaskInputClaim): void {
  const state = states.get(claim);
  if (!state?.used || !state.authorized || state.admitted || !current(claim)) {
    throw new Error("Task input attribution is unavailable");
  }
}

/** The final check and enqueue share a stack: no await may separate them. */
export function admitTaskInput<T>(claim: TaskInputClaim, enqueue: () => T): T {
  assertTaskInputCurrent(claim);
  states.get(claim)!.admitted = true;
  // The receiving turn owns its actor, not this already-consumed send scope.
  return withoutTaskInputActor(enqueue);
}
