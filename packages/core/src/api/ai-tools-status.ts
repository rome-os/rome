import type { AIToolsStatus } from "@rome/api-types/ai-tools";
import type { ApiDeps } from "./deps.js";
import type { LiveEventEmit } from "../lib/live-event.js";

type StatusDeps = Pick<ApiDeps, "aiToolState" | "codexAccountService">;

export function buildAiToolsStatus(deps: StatusDeps): AIToolsStatus {
  const state = deps.aiToolState.get();
  const login = deps.codexAccountService.getLoginState();
  return {
    claude: state.claude,
    codex: state.codex,
    codexLogin: {
      running: login.running && login.mode === "browser",
      lastExit: null,
      lastError: login.lastError,
    },
    codexDeviceLogin: {
      running: login.running && login.mode === "device",
      userCode: login.mode === "device" ? login.userCode : null,
      verificationUrl: login.mode === "device" ? login.verificationUrl : null,
      lastError: login.lastError,
    },
    anthropicCompatible: state.claude.anthropicCompatible ?? null,
  };
}

/** Replays the cache on subscribe and reconnect. Never probes a provider. */
export function subscribeAiToolsStatus(deps: StatusDeps, emit: LiveEventEmit): () => void {
  const send = () => emit("status", buildAiToolsStatus(deps));
  send();
  return deps.aiToolState.subscribe(send);
}
