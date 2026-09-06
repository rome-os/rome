import type {
  GeneratedImageTracker,
  ImageTraceSessionState,
  ToolTraceState,
} from "./image-trace.js";
import type { AgentMessageSink } from "./session.js";
import type { RomeDynamicTools } from "./rome-dynamic-tools.js";

/** Per-turn routing state shared by ordinary and borrowed Codex turns. */
export interface CodexTurnRuntime {
  ownerSessionId: string;
  sink: AgentMessageSink;
  imageTraceCtx: ToolTraceState & ImageTraceSessionState;
  imageTracker: GeneratedImageTracker;
  romeTools: RomeDynamicTools;
  isClosed: () => boolean;
  /**
   * Optional provider operation that must finish after the model turn but
   * before Rome exposes its terminal event. The borrowed exact-fork adapter
   * uses this seam to restore source history with thread/revert.
   */
  beforeTerminal?: (turn: { threadId: string; turnId: string }) => Promise<void>;
}
