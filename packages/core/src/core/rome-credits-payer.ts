import type { AIToolState } from "./ai-tool-state.js";
import { ROME_CREDITS_MODEL_PROVIDER_ID } from "./codex/rome-credits-provider.js";
import { getInstanceToken } from "../lib/instance-identity.js";

export interface CodexPayerManager {
  setDefaultProvider(provider: string | null): void;
  restart(): void;
}

export interface RomeCreditsPayer {
  sync(): void;
  isUsingRomeCredits(): boolean;
  close(): void;
}

/**
 * Selects Codex's process-wide payer. The guardian's ChatGPT login wins; Rome
 * credits are only used when that login is unavailable and this instance holds
 * a Rome Cloud credential. `setDefaultProvider` deliberately hard-restarts
 * Codex when this selection changes.
 */
export function createRomeCreditsPayer(options: {
  aiToolState: Pick<AIToolState, "get">;
  appServerManager: CodexPayerManager;
  getInstanceToken?: () => string | null;
}): RomeCreditsPayer {
  const token = options.getInstanceToken ?? getInstanceToken;
  let provider: string | null = null;
  let instanceToken = token();
  let closed = false;

  return {
    sync() {
      if (closed) return;
      const codex = options.aiToolState.get().codex;
      const ownLoginCanRun = codex.loggedIn !== false && !codex.quotaExhausted;
      const nextToken = token();
      const tokenChanged = nextToken !== instanceToken;
      instanceToken = nextToken;
      const next = !ownLoginCanRun && nextToken ? ROME_CREDITS_MODEL_PROVIDER_ID : null;
      if (next === provider) {
        if (tokenChanged) options.appServerManager.restart();
        return;
      }
      provider = next;
      options.appServerManager.setDefaultProvider(next);
    },
    isUsingRomeCredits() {
      return provider === ROME_CREDITS_MODEL_PROVIDER_ID;
    },
    close() {
      closed = true;
    },
  };
}
