import type { AIToolState } from "./ai-tool-state.js";
import { ROME_CREDITS_MODEL_PROVIDER_ID } from "./codex/rome-credits-provider.js";
import { getInstanceToken } from "../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";

/** A turn whose payer changed between its model resolution and dispatch. */
export const PAYER_CHANGED_MESSAGE = "Model payer changed while preparing this turn; please retry.";

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
 * Selects Codex's process-wide payer from login state. The guardian's ChatGPT
 * login wins; Rome credits are only used when ChatGPT is disconnected and this
 * instance has a Rome Cloud origin and credential. `setDefaultProvider`
 * deliberately hard-restarts Codex when this selection changes.
 */
export function createRomeCreditsPayer(options: {
  aiToolState: Pick<AIToolState, "get">;
  appServerManager: CodexPayerManager;
  getInstanceToken?: () => string | null;
  hasRomeCloud?: () => boolean;
}): RomeCreditsPayer {
  const token = options.getInstanceToken ?? getInstanceToken;
  const hasRomeCloud = options.hasRomeCloud ?? (() => getRomeCloudOrigin() !== null);
  let provider: string | null = null;
  let instanceToken = token();
  let closed = false;

  return {
    sync() {
      if (closed) return;
      const codex = options.aiToolState.get().codex;
      const hasChatGptLogin = codex.loggedIn !== false;
      const nextToken = token();
      const tokenChanged = nextToken !== instanceToken;
      instanceToken = nextToken;
      const next =
        !hasChatGptLogin && nextToken && hasRomeCloud() ? ROME_CREDITS_MODEL_PROVIDER_ID : null;
      if (next === provider) {
        // Only the credits provider reads the token, and each spawn re-reads it.
        if (tokenChanged && provider === ROME_CREDITS_MODEL_PROVIDER_ID) {
          options.appServerManager.restart();
        }
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
