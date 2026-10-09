import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import type { AIToolState } from "./ai-tool-state.js";
import { ROME_CREDITS_MODEL_PROVIDER_ID } from "./codex/rome-credits-provider.js";
import { getInstanceToken } from "../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import { fetchRomeCredits } from "../lib/rome-credits.js";
import { createLogger } from "../logger.js";

const log = createLogger("rome-credits-payer");

export interface CodexPayerManager {
  getDefaultProvider(): string | null;
  setDefaultProvider(provider: string | null): void;
  restart(): void;
}

export interface RomeCreditsPayer {
  sync(): void;
  isUsingRomeCredits(): boolean;
  /**
   * The Codex models the Rome credits gateway last reported serving, or null
   * while unknown: not fetched yet, the gateway does not report them, or the
   * instance credential changed since the last report.
   */
  servedModels(): readonly string[] | null;
  /**
   * Re-reads the served models while Rome credits pay, and does nothing
   * otherwise. Never rejects. A failed read keeps the last snapshot.
   */
  refreshServedModels(): Promise<void>;
  /**
   * Settles once the first read after credits start paying, or after a
   * credential change, has finished, and at once otherwise. Later refreshes
   * never make it wait again.
   */
  servedModelsSettled(): Promise<void>;
  close(): void;
}

/**
 * Selects Codex's process-wide payer from login state. The guardian's ChatGPT
 * login wins; Rome credits are only used when ChatGPT is disconnected and this
 * instance has a Rome Cloud origin and credential. `setDefaultProvider`
 * deliberately hard-restarts Codex when this selection changes. Switching to
 * Rome credits, or changing the credential while they pay, also re-reads the
 * models the gateway serves.
 */
export function createRomeCreditsPayer(options: {
  aiToolState: Pick<AIToolState, "get">;
  appServerManager: CodexPayerManager;
  getInstanceToken?: () => string | null;
  hasRomeCloud?: () => boolean;
  fetchRomeCredits?: () => Promise<RomeCreditsView | null>;
}): RomeCreditsPayer {
  const token = options.getInstanceToken ?? getInstanceToken;
  const hasRomeCloud = options.hasRomeCloud ?? (() => getRomeCloudOrigin() !== null);
  const provider = (): string | null => options.appServerManager.getDefaultProvider();
  const fetchCredits = options.fetchRomeCredits ?? (() => fetchRomeCredits());
  let instanceToken = token();
  let closed = false;
  let served: readonly string[] | null = null;
  let inFlight: { promise: Promise<void> } | null = null;
  // The first read of a credits period or credential; null once it finished.
  let firstRead: Promise<void> | null = null;

  const isUsingRomeCredits = (): boolean => provider() === ROME_CREDITS_MODEL_PROVIDER_ID;

  const refreshServedModels = (): Promise<void> => {
    if (closed || !isUsingRomeCredits()) return Promise.resolve();
    if (inFlight) return inFlight.promise;
    const read = { promise: Promise.resolve() };
    inFlight = read;
    read.promise = (async () => {
      try {
        const view = await fetchCredits();
        // A null view is a rejected credential or an account with no grant,
        // not a report of what the gateway serves, so it changes nothing.
        if (inFlight === read && view) served = view.models ? [...view.models] : null;
      } catch (err) {
        log.warn("Rome credits served models unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (inFlight === read) inFlight = null;
      }
    })();
    return read.promise;
  };

  const startPeriod = (): void => {
    const pending: Promise<void> = refreshServedModels().then(() => {
      if (firstRead === pending) firstRead = null;
    });
    firstRead = pending;
  };

  return {
    sync() {
      if (closed) return;
      const codex = options.aiToolState.get().codex;
      const hasChatGptLogin = codex.loggedIn !== false;
      const nextToken = token();
      const tokenChanged = nextToken !== instanceToken;
      instanceToken = nextToken;
      if (tokenChanged) {
        // Another credential can belong to another account, so neither the
        // snapshot nor a read still in flight describes it.
        served = null;
        inFlight = null;
        firstRead = null;
      }
      const next =
        !hasChatGptLogin && nextToken && hasRomeCloud() ? ROME_CREDITS_MODEL_PROVIDER_ID : null;
      if (next === provider()) {
        // Only the credits provider reads the token, and each spawn re-reads it.
        if (tokenChanged && next === ROME_CREDITS_MODEL_PROVIDER_ID) {
          options.appServerManager.restart();
          startPeriod();
        }
        return;
      }
      options.appServerManager.setDefaultProvider(next);
      if (next === ROME_CREDITS_MODEL_PROVIDER_ID) {
        startPeriod();
      } else {
        // A later credits period starts from a fresh read, not this list.
        served = null;
        inFlight = null;
        firstRead = null;
      }
    },
    isUsingRomeCredits,
    servedModels: () => served,
    refreshServedModels,
    servedModelsSettled: () => firstRead ?? Promise.resolve(),
    close() {
      closed = true;
    },
  };
}
