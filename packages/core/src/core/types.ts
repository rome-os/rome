import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type {
  ForkRunParams as SdkForkRunParams,
  RunParams as SdkRunParams,
} from "@rome-os/app-runtime";
import type { NotifyLevel } from "../instance/notify-client.js";
import type { TurnActor } from "../agent/index.js";
import type { AgentEvent } from "../types.js";

export type { ForkRunMode, ForkSourceCheckpoint, ThreadContext } from "@rome-os/app-runtime";

export interface RunParams extends SdkRunParams {
  shouldRun?: () => boolean;
  /** Internal continuations should not be treated as guardian-authored turns. */
  initiatedBy?: "user" | "system";
  /** Each message the agent says in this turn goes to the phone of the person
   *  the chat serves, as a push at this level (ConciergePush). Absent, the
   *  turn pushes nothing. */
  pushLevel?: NotifyLevel;
  /** Who the turn acts for, such as the person whose reminder woke it. Absent, no one. */
  actor?: TurnActor;
  /** The id of the one Concierge task this turn reports on. Absent, it
   *  reports on none or on several. */
  reportedTask?: string;
  /** Whether the runner saves the turn's trace. Defaults to every channel but
   *  webchat, whose chat route saves the trace of the turns it runs. */
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
  /** Who sent the input, when a routine, an app or another agent sent it
   *  into the chat. Kept on the `system_input` block with the label. */
  inputSource?: SystemInputSource;
}

export interface ForkRunParams extends SdkForkRunParams {
  /**
   * Builds the channel-thread key to leave the completed fork resumable under,
   * from the fork session id that `fork` mints. When set, the fork
   * asks the provider for a thread of its own and persists it, so a later
   * `open` on this key continues the branch instead of opening a fresh
   * conversation. Absent — the default — keeps the fork one-shot and ephemeral.
   *
   * A function because the key derives from an id the caller does not have
   * until the run starts.
   */
  persistThreadKey?: (forkSessionId: string) => string;
  /** Who the forked turn acts for: the person who asked for the fork. Absent, no one. */
  actor?: TurnActor;
}

export interface AgentRunnerInterface {
  run(params: RunParams): AsyncIterable<AgentEvent>;
  runForked?(params: ForkRunParams): AsyncIterable<AgentEvent>;
}
