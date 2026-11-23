// The default provider as Rome keeps it: loaded once, changed by the guardian,
// and moved only by a login when none could run, or a logout of the provider
// it was. A failure never moves it.
// docs/domains/agents.md carries the language.

import type { AgentLog } from "../domain/agent-log.js";
import {
  legacyDefault,
  providerOfDefault,
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
  /**
   * `guardian` when the guardian chose it, `removed` when a logout moved it,
   * `first` when the first login replaced none or Rome credits.
   */
  by: "guardian" | "removed" | "first";
  /**
   * Whether chats that follow the default move with it, each on its next run.
   * The guardian's own change and a logout may leave them where they are. A
   * login that replaces Rome credits moves them all.
   */
  moveExisting: boolean;
};

export interface DefaultProviders {
  /** Loads the stored default. Every other call waits for it. */
  ready(): Promise<void>;
  /** The default, or null when none is set. Null also before `ready`. */
  current(): DefaultProvider | null;
  /** What a removal moved, until the guardian dismisses it or picks a default. */
  note(): DefaultProviderNote | undefined;
  signedIn(): SignedInProviders;
  /**
   * The guardian's choice. With `moveExisting` false, chats that follow the
   * default stay on the provider they run on. Throws when the provider is not
   * signed in.
   */
  choose(provider: DefaultProvider, options?: { moveExisting?: boolean }): Promise<void>;
  dismissNote(): Promise<void>;
  /**
   * Before the guardian logs out of `provider`: whether the chats that follow
   * the default move with it, if the logout moves it. Absent, they move. The
   * choice holds until the returned call, once the logout has ended, so a
   * reconcile that runs first does not spend it. The accounts reading the
   * provider as logged out spends it, and it expires two minutes after the
   * logout, as when the logout left the provider signed in. The returned call
   * drops it when the logout failed.
   */
  expectLogout(
    provider: AccountedProviderId,
    options: { moveExisting: boolean },
  ): () => Promise<void>;
  /** Checks the default against the providers signed in now. */
  reconcile(): Promise<void>;
  onChanged(listener: (change: DefaultProviderChange) => void): () => void;
}

export interface CreateDefaultProvidersOptions {
  setting: DefaultProviderSetting;
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  /** The providers whose accounts must be read before the default can move. */
  providers: readonly AccountedProviderId[];
  /**
   * Whether the guardian's Rome account has credits enabled, linked to this
   * instance; undefined until Rome knows. They count as signed in only while
   * no AI account is.
   */
  creditsEnabled: () => boolean | undefined;
  /**
   * Whether Rome credits can be spent now: enabled, linked, with a balance.
   * Only then does the last logout hand them the default, as its dialog
   * says. Absent, enabled credits count.
   */
  creditsUsable?: () => boolean;
  /**
   * The provider an upgrade starts from when one is signed in, ahead of the
   * old order: the provider the Concierge main chat already runs on.
   */
  seed?: () => Promise<DefaultProvider | null>;
  /**
   * Runs before a change is stored, so no chat runs between the change and
   * what it does to chats: keeping them where they are, or letting them move.
   * A failure stops the change.
   */
  beforeChange?: (change: DefaultProviderChange) => Promise<void>;
  log?: AgentLog;
  now?: () => Date;
}

export function createDefaultProviders(options: CreateDefaultProvidersOptions): DefaultProviders {
  const { setting, accounts, log } = options;
  const now = options.now ?? (() => new Date());
  let state: DefaultProviderState = { provider: null };
  const listeners = new Set<(change: DefaultProviderChange) => void>();
  // What the guardian chose in the logout dialog, until the logout moves the default.
  const logouts = new Map<AccountedProviderId, { moveExisting: boolean; at: number }>();
  // Long enough for the account read a logout starts to land, short enough
  // that a logout that left the provider signed in spends nothing later.
  const LOGOUT_CHOICE_MS = 2 * 60_000;
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
      options.creditsEnabled() ?? state.provider === "rome_credits",
    );

  const store = async (next: DefaultProviderState, change?: DefaultProviderChange) => {
    if (change) await options.beforeChange?.(change);
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
      const leaving = state.provider ? providerOfDefault(state.provider) : null;
      for (const [logout, choice] of logouts) {
        if (now().getTime() - choice.at > LOGOUT_CHOICE_MS) logouts.delete(logout);
      }
      // Rome credits take the default over only in the guardian's logout of
      // it, as its dialog said: a later top-up never changes the default.
      const loggingOut = leaving !== null && logouts.has(leaving) && !now_[leaving];
      const { provider, moved } = reconciledDefault(
        state.provider,
        now_,
        seeded && now_[seeded] ? seeded : legacyDefault(reports, now_),
        loggingOut && (options.creditsUsable?.() ?? true),
      );
      // A logout the accounts now read as done has spent its choice.
      const choice = leaving ? logouts.get(leaving) : undefined;
      for (const [logout] of logouts) if (!now_[logout]) logouts.delete(logout);
      if (!provider || provider === state.provider) return;
      const from = state.provider;
      const removed = moved && from ? providerOfDefault(from) : null;
      const moveExisting = (removed && removed === leaving && choice?.moveExisting) ?? true;
      await store(
        {
          provider,
          ...(moved && from ? { note: { from, to: provider, at: now().toISOString() } } : {}),
        },
        { from, to: provider, by: moved ? "removed" : "first", moveExisting },
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
    choose: (provider, choice) =>
      serial(async () => {
        await loaded;
        if (!signedIn()[provider]) throw new Error(`${provider} is not signed in`);
        const from = state.provider;
        const moveExisting = choice?.moveExisting ?? true;
        if (from === provider) {
          // Choosing the default again with "Move existing chats too" lets
          // every held conversation follow it, as a checked change does.
          if (moveExisting) {
            await options.beforeChange?.({ from, to: provider, by: "guardian", moveExisting });
          }
          // Picking it clears a removal's note.
          await store({ provider });
          return;
        }
        await store({ provider }, { from, to: provider, by: "guardian", moveExisting });
      }),
    dismissNote: () =>
      serial(async () => {
        await loaded;
        if (state.note && state.provider) await store({ provider: state.provider });
      }),
    expectLogout(provider, choice) {
      const token = { moveExisting: choice.moveExisting, at: now().getTime() };
      logouts.set(provider, token);
      // Queued behind any reconcile already waiting, which may still spend it.
      return () =>
        serial(async () => {
          if (logouts.get(provider) === token) logouts.delete(provider);
        });
    },
    reconcile,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
