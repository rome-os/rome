import type {
  ForkRunParams as SdkForkRunParams,
  RunParams as SdkRunParams,
  SessionCaller,
} from "@rome-os/app-runtime";
import type { AgentEvent } from "../types.js";

export type { ForkRunMode, ForkSourceCheckpoint, ThreadContext } from "@rome-os/app-runtime";

export interface RunParams extends SdkRunParams {
  /** Internal continuations should not be treated as guardian-authored turns. */
  initiatedBy?: "user" | "system";
  /** Whether the run puts the turn's answer on record in the chat it replies
   *  into, as Chats' copy. Defaults to true. A caller that puts the answer on
   *  record as it delivers it turns it off, so the chat holds it once, and
   *  only once it went out. The session keeps its own copy either way. */
  chatAnswer?: boolean;
  /** Keeps this turn's prompt in its saved trace under this label, as a
   *  `system_input` block. Only callers that ask for it; nothing more is
   *  sent to the model. */
  inputLabel?: string;
}

export interface ForkRunParams extends SdkForkRunParams {
  /**
   * The caller to leave the completed fork resumable for, from the fork
   * session id that `runForkedTurn` mints. When set, the fork asks the
   * provider for a thread of its own and keeps it, so a later `open` by this
   * caller continues the branch instead of opening a fresh conversation.
   * Absent, the default, keeps the fork one-shot and ephemeral.
   *
   * A function because the caller names an id it does not have until the run
   * starts.
   */
  continueAs?: (forkSessionId: string) => SessionCaller;
  /**
   * The source's completed turn the fork continues from, in place of a
   * `sourceCheckpoint` the caller read. The run throws `NoForkPointError`
   * before any event when that turn kept no point to fork at.
   */
  atTurn?: string;
}

export interface AgentRunnerInterface {
  run(params: RunParams): AsyncIterable<AgentEvent>;
  runForked?(params: ForkRunParams): AsyncIterable<AgentEvent>;
}
