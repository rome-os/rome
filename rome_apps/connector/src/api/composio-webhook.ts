import type { AppSettingsRepository } from "@rome-os/app-runtime";

import type { ComposioClient } from "./composio-client.js";
import { resolveRelayDepositUrl } from "./relay-webhook.js";
import type { SettingsStore } from "./settings-store.js";

export class RelayWebhookUnavailableError extends Error {
  constructor() {
    super("Webhook relay is not configured. Configure Relay in Settings, then try again.");
  }
}

function assertHttpsRelayDepositUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Relay deposit URL is invalid: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Relay deposit URL must use HTTPS (got ${parsed.protocol}//${parsed.host}). ` +
        "Composio only accepts public HTTPS webhook URLs.",
    );
  }
}

/**
 * Point the active Composio project at this instance's relay mailbox and store
 * the signing material needed to verify deliveries after core drains them.
 *
 * `setWebhookUrl` is already a non-destructive LIST -> PATCH/POST upsert. We
 * intentionally run it on every explicit recovery point instead of trusting a
 * cached secret: this repairs a changed mailbox address, externally deleted
 * endpoint, or newly issued signing secret without a second state machine.
 */
export async function ensureComposioWebhookRegistered(input: {
  client: Pick<ComposioClient, "setWebhookUrl">;
  appSettings: Pick<SettingsStore, "set">;
  settings: Pick<AppSettingsRepository, "get">;
}): Promise<{ webhookUrl: string }> {
  const webhookUrl = await resolveRelayDepositUrl(input.settings);
  if (!webhookUrl) throw new RelayWebhookUnavailableError();
  assertHttpsRelayDepositUrl(webhookUrl);

  const endpoint = await input.client.setWebhookUrl(webhookUrl);
  await input.appSettings.set("webhookSecret", endpoint.secret);
  await input.appSettings.set("webhookEndpointId", endpoint.id);
  return { webhookUrl };
}

/**
 * Where the Composio project's one webhook delivers: to this instance's relay
 * mailbox (`ours`), to another URL (`elsewhere`, usually another Rome on the
 * same project, which registered after this one), nowhere (`none`), or
 * `unknown` when Composio, the relay or the URL could not be read.
 */
export type ComposioWebhookTarget = "ours" | "elsewhere" | "none" | "unknown";

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

/** Reads where the project's webhook delivers, without changing it. */
export async function composioWebhookTarget(input: {
  client: Pick<ComposioClient, "getWebhookUrl"> | null;
  settings: Pick<AppSettingsRepository, "get">;
}): Promise<ComposioWebhookTarget> {
  const ours = await resolveRelayDepositUrl(input.settings);
  if (!input.client || !ours) return "unknown";
  let current: string | null | undefined;
  try {
    current = await input.client.getWebhookUrl();
  } catch {
    return "unknown";
  }
  if (current === undefined) return "unknown";
  return current === null ? "none" : sameUrl(current, ours) ? "ours" : "elsewhere";
}
