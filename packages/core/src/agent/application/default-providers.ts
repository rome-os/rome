// The default provider as Rome keeps it: loaded once, changed by the guardian,
// and moved only when the guardian removes the provider it was.
// docs/domains/agents.md carries the language.

import type { AgentLog } from "../domain/agent-log.js";
import {
  legacyDefault,
  reconciledDefault,
  signedInProviders,
  type DefaultProvider,
  type DefaultProviderNote,
  type DefaultProviderSetting,
  type DefaultProviderState,
  type SignedInProviders,
} from "../domain/default-provider.js";
import type { AccountedProviderId } from "../domain/model-account-report.js";
import type { ModelAccounts } from "./model-accounts.js";

export type DefaultProviderChange = {
  from: DefaultProvider | null;
  to: DefaultProvider;
  /** `guardian` when the guardian chose it, `removed` when a removal moved it. */
  by: "guardian" | "removed" | "first";
};

export interface DefaultProviders {
  /** Loads the stored default. Every other call waits for it. */
  ready(): Promise<void>;
  /** The default, or null when none is set. Null also before `ready`. */
  current(): DefaultProvider | null;
  /** What a removal moved, until the guardian dismisses it or picks a default. */
  note(): DefaultProviderNote | undefined;
  signedIn(): SignedInProviders;
  /** The guardian's choice. Throws when the provider is not signed in. */
  choose(provider: DefaultProvider): Promise<void>;
  dismissNote(): Promise<void>;
  /** Checks the default against the providers signed in now. */
  reconcile(): Promise<void>;
  onChanged(listener: (change: DefaultProviderChange) => void): () => void;
}

export interface CreateDefaultProvidersOptions {
  setting: DefaultProviderSetting;
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  /** The providers whose accounts must be read before the default can move. */
  providers: readonly AccountedProviderId[];
  /** Whether Rome credits count as signed in; undefined until Rome knows. */
  creditsSignedIn: () => boolean | undefined;
  /**
   * The provider an upgrade starts from when one is signed in, ahead of the
   * old order: the provider the Concierge main chat already runs on.
   */
  seed?: () => Promise<DefaultProvider | null>;
  log?: AgentLog;
  now?: () => Date;
}

export function createDefaultProviders(options: CreateDefaultProvidersOptions): DefaultProviders {
  const { setting, accounts, log } = options;
  const now = options.now ?? (() => new Date());
  let state: DefaultProviderState = { provider: null };
  const listeners = new Set<(change: DefaultProviderChange) => void>();
  // One write at a time, in order, so a reconcile never undoes a choice.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const loaded = setting
    .read()
    .then((read) => {
      state = read;
    })
    .catch((error: unknown) => {
      log?.warn("default provider read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  // Credits Rome has not read yet keep a default that is them, and are not
  // picked as a new one.
  const signedIn = () =>
    signedInProviders(
      accounts.read(),
      options.creditsSignedIn() ?? state.provider === "rome_credits",
    );

  const store = async (next: DefaultProviderState, change?: DefaultProviderChange) => {
    await setting.write(next);
    state = next;
    if (!change) return;
    log?.info("default provider changed", { ...change });
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        log?.warn("default provider listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const reconcile = () =>
    serial(async () => {
      await loaded;
      const reports = accounts.read();
      // A provider Rome has not read yet may still be signed in.
      if (options.providers.some((provider) => reports[provider] === undefined)) return;
      const now_ = signedIn();
      const seeded = state.provider === null ? await options.seed?.().catch(() => null) : null;
      const { provider, moved } = reconciledDefault(
        state.provider,
        now_,
        seeded && now_[seeded] ? seeded : legacyDefault(reports, now_),
      );
      if (!provider || provider === state.provider) return;
      const from = state.provider;
      await store(
        {
          provider,
          ...(moved && from ? { note: { from, to: provider, at: now().toISOString() } } : {}),
        },
        { from, to: provider, by: moved ? "removed" : "first" },
      );
    });

  accounts.onChanged((_provider, change) => {
    if (change === "authorization" || change === "refreshed") {
      void reconcile().catch((error: unknown) =>
        log?.warn("default provider reconcile failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  return {
    ready: () => loaded,
    current: () => state.provider,
    note: () => state.note,
    signedIn,
    choose: (provider) =>
      serial(async () => {
        await loaded;
        if (!signedIn()[provider]) throw new Error(`${provider} is not signed in`);
        const from = state.provider;
        await store(
          { provider },
          from === provider ? undefined : { from, to: provider, by: "guardian" },
        );
      }),
    dismissNote: () =>
      serial(async () => {
        await loaded;
        if (state.note && state.provider) await store({ provider: state.provider });
      }),
    reconcile,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
