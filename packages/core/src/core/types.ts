import type {
  ForkRunParams as SdkForkRunParams,
  RunParams as SdkRunParams,
} from "@rome-os/app-runtime";
import type { AgentEvent } from "../types.js";

export type { ForkRunMode, ForkSourceCheckpoint, ThreadContext } from "@rome-os/app-runtime";

export interface RunParams extends SdkRunParams {
  /** Internal continuations should not be treated as guardian-authored turns. */
  initiatedBy?: "user" | "system";
  /** Whether the runner saves the turn's trace. Defaults to every channel but
   *  webchat, whose chat route saves the trace of the turns it runs. */
  persistTrace?: boolean;
  /** Whether a saved trace also writes the turn's user and assistant
   *  transcript rows. Defaults to true. A caller whose channel keeps its own
   *  transcript turns it off. A turn routed into a recorded subagent or fork
   *  conversation writes them anyway, since that conversation has no other
   *  transcript. */
  persistTranscript?: boolean;
}

export interface ForkRunParams extends SdkForkRunParams {
  /**
   * Builds the channel-thread key to leave the completed fork resumable under,
   * from the fork session id that `runForkedTurn` mints. When set, the fork
   * asks the provider for a thread of its own and persists it, so a later
   * `acquire` on this key continues the branch instead of opening a fresh
   * conversation. Absent — the default — keeps the fork one-shot and ephemeral.
   *
   * A function because the key derives from an id the caller does not have
   * until the run starts.
   */
  persistThreadKey?: (forkSessionId: string) => string;
}

export interface AgentRunnerInterface {
  run(params: RunParams): AsyncIterable<AgentEvent>;
  runForked?(params: ForkRunParams): AsyncIterable<AgentEvent>;
}
