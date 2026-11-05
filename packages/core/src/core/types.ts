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
  /** Whether the session's log keeps the turn's trace. Defaults to true. On
   *  the dashboard chat, a run that leaves it unset keeps only the trace,
   *  since the chat writes the turn's lines itself. */
  persistTrace?: boolean;
  /** Whether a saved trace also writes the turn's user and assistant
   *  transcript rows. Defaults to true. A caller whose channel keeps its own
   *  transcript turns it off. A turn routed into a recorded subagent or fork
   *  conversation writes them anyway, since that conversation has no other
   *  transcript, while an explicit `persistTrace: false` still skips both. */
  persistTranscript?: boolean;
  /** Whether those transcript rows include the turn's answer. Defaults to
   *  true. A caller that puts the answer on record as it delivers it turns it
   *  off, so the answer is recorded once, and only once it went out. A
   *  recorded subagent or fork conversation keeps it anyway. */
  persistAnswer?: boolean;
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
