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
   * Re-reads the account's credits while ChatGPT is disconnected, and does
   * nothing otherwise. Credits start or stop paying with the answer. Never
   * rejects. A failed read keeps the current payer and snapshot.
   */
  refresh(): Promise<void>;
  /**
   * Settles once the first read after ChatGPT disconnects, or after a
   * credential change, has finished, and at once otherwise. Later refreshes
   * never make it wait again.
   */
  settled(): Promise<void>;
  close(): void;
}

/** Credits pay only while the account can spend them. */
function canSpend(view: RomeCreditsView | null): view is RomeCreditsView {
  return view !== null && view.enabled && BigInt(view.availableMicros) > 0n;
}

/**
 * Selects Codex's process-wide payer from login state and the account's
 * credits. The guardian's ChatGPT login wins. Rome credits are only used when
 * ChatGPT is disconnected, this instance has a Rome Cloud origin and
 * credential, and the last read found credits the account can spend.
 * `setDefaultProvider` deliberately hard-restarts Codex when this selection
 * changes. A read also refreshes the models the gateway serves.
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
  // Whether ChatGPT is disconnected and a credential could spend credits, as
  // of the last sync. Reads happen only while it holds.
  let eligible = false;
  let served: readonly string[] | null = null;
  let inFlight: { promise: Promise<void> } | null = null;
  // The first read of an eligible period or credential; null once it finished.
  let firstRead: Promise<void> | null = null;

  const isUsingRomeCredits = (): boolean => provider() === ROME_CREDITS_MODEL_PROVIDER_ID;

  const select = (next: string | null): void => {
    if (provider() !== next) options.appServerManager.setDefaultProvider(next);
  };

  const refresh = (): Promise<void> => {
    if (closed || !eligible) return Promise.resolve();
    if (inFlight) return inFlight.promise;
    const read = { promise: Promise.resolve() };
    inFlight = read;
    read.promise = (async () => {
      try {
        const view = await fetchCredits();
        // A sync since this read began changed what it would describe.
        if (inFlight !== read || closed) return;
        // A null view is a rejected credential or an account with no grant.
        if (canSpend(view)) {
          served = view.models ? [...view.models] : null;
          select(ROME_CREDITS_MODEL_PROVIDER_ID);
        } else {
          served = null;
          select(null);
        }
      } catch (err) {
        log.warn("Rome credits unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (inFlight === read) inFlight = null;
      }
    })();
    return read.promise;
  };

  const startPeriod = (): void => {
    const pending: Promise<void> = refresh().then(() => {
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
      const wasEligible = eligible;
      eligible = !hasChatGptLogin && Boolean(nextToken) && hasRomeCloud();
      if (tokenChanged || !eligible) {
        // Another credential can belong to another account, so neither the
        // snapshot nor a read still in flight describes it.
        served = null;
        inFlight = null;
        firstRead = null;
      }
      if (!eligible) {
        select(null);
        return;
      }
      // Only the credits provider reads the token, and each spawn re-reads it.
      if (tokenChanged && isUsingRomeCredits()) options.appServerManager.restart();
      if (tokenChanged || !wasEligible) startPeriod();
    },
    isUsingRomeCredits,
    servedModels: () => served,
    refresh,
    settled: () => firstRead ?? Promise.resolve(),
    close() {
      closed = true;
    },
  };
}
