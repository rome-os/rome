// The guardian logging Rome out of a model provider, from AI Tools or from the
// chat. The default provider learns first whether the chats that follow it
// move, in case the logout moves it; then the login is taken back and the
// account read again, so turns see the logout at once.
// docs/domains/agents.md#default-provider carries the language.

import type { ModelProviderLogins } from "../domain/model-login.js";
import type { AccountedProviderId } from "../domain/model-account-report.js";
import type { DefaultProviders } from "./default-providers.js";
import type { ModelAccounts } from "./model-accounts.js";

export interface ModelLogoutDeps {
  /** Absent where Rome keeps no default provider. */
  defaults?: Pick<DefaultProviders, "expectLogout">;
  accounts: Pick<ModelAccounts, "refresh">;
  logins: Record<AccountedProviderId, ModelProviderLogins>;
}

/**
 * Runs `logout` as the guardian's logout of `provider`. With `moveExisting`
 * false, the chats that follow the default stay where they run if the logout
 * moves the default. Throws what `logout` throws.
 */
export async function loggingOut(
  defaults: ModelLogoutDeps["defaults"],
  provider: AccountedProviderId,
  options: { moveExisting: boolean },
  logout: () => Promise<void>,
): Promise<void> {
  const failed = defaults?.expectLogout(provider, options);
  try {
    await logout();
  } catch (error) {
    await failed?.();
    throw error;
  }
}

/** Logs Rome out of the guardian's own login to `provider`. Throws when the provider refuses. */
export async function logOutOfProvider(
  deps: ModelLogoutDeps,
  provider: AccountedProviderId,
  options: { moveExisting: boolean },
): Promise<void> {
  await loggingOut(deps.defaults, provider, options, async () => {
    await deps.logins[provider].revoke();
    await deps.accounts.refresh(provider);
  });
}
