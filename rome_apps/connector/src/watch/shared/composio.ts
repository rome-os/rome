// What every Composio source shares: its kinds' triggers, whether an armed
// trigger serves a follow, the connected account's identity read once, and
// the adapter built from a catalog, its triggers, an account read and a
// normalizer. A Composio source's adapter is this factory and its own parts.

import type { ActiveTrigger } from "../../api/composio-client.js";
import { PROVIDER_EVENT_PREFIX } from "../../api/topic.js";
import type {
  ComposioToolkit,
  ComposioTriggerSpec,
  Json,
  Normalized,
  WatchAdapter,
  WatchEnv,
  Watchable,
  WatchTrigger,
} from "../types.js";
import { eventNameOf } from "./event.js";

/** The trigger of a Composio spec, as a kind lists it. */
export const fromComposio = (spec: ComposioTriggerSpec): WatchTrigger => ({
  provider: spec.toolkit,
  type: spec.slug.toLowerCase(),
});

/**
 * Whether an active Composio trigger already delivers what a follow needs:
 * the spec's trigger, for the connected account, with this app's config and
 * none of the keys that would narrow it. One for another account, another
 * config, or one narrowed to a team or a page does not.
 */
export function armsWatch(
  trigger: ActiveTrigger,
  spec: ComposioTriggerSpec,
  accountId: string,
): boolean {
  if (trigger.triggerName.toUpperCase() !== spec.slug) return false;
  if (!trigger.connectedAccountIds.includes(accountId)) return false;
  const narrowed = (spec.unscoped ?? []).some(
    (key) =>
      trigger.triggerConfig[key] !== undefined &&
      trigger.triggerConfig[key] !== null &&
      trigger.triggerConfig[key] !== "",
  );
  if (narrowed) return false;
  return Object.entries(spec.config).every(
    ([key, value]) => JSON.stringify(trigger.triggerConfig[key]) === JSON.stringify(value),
  );
}

/** Identities change only with the connection, so one read per account is enough. */
const identities = new Map<string, unknown>();

/** A connected account's identity, read once per account. */
export async function identityOf<T>(
  env: WatchEnv,
  service: ComposioToolkit,
  read: () => Promise<T>,
): Promise<T> {
  const key = `${service.toolkit}:${await env.composio.accountId(service)}`;
  if (identities.has(key)) return identities.get(key) as T;
  const value = await read();
  identities.set(key, value);
  return value;
}

/** A value an identity read must find. */
export function required(service: ComposioToolkit, value: string | undefined): string {
  if (!value) throw new Error(`${service.label} did not say who is connected`);
  return value;
}

export const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
export const record = (value: unknown): Json =>
  value && typeof value === "object" ? (value as Json) : {};

export interface ComposioAdapterParts {
  catalog: Watchable;
  /** Every trigger the catalog's kinds name, with the config this app arms it with. */
  triggers: readonly ComposioTriggerSpec[];
  /** Whose account the events concern: the mailbox address, the Linear user, the Stripe account. */
  account(env: WatchEnv, service: ComposioToolkit): Promise<string>;
  /** An event of `type`, the trigger slug in lower case, in the common shape. */
  normalize(
    env: WatchEnv,
    input: {
      type: string;
      payload: Json;
      account: string;
      kinds: ReadonlySet<string>;
      service: ComposioToolkit;
    },
  ): Promise<Normalized> | Normalized;
}

/** A Composio source's adapter: its toolkit is its source, and it follows the connected account. */
export function composioAdapter(parts: ComposioAdapterParts): WatchAdapter {
  const { catalog } = parts;
  const service: ComposioToolkit = { toolkit: catalog.source, label: catalog.label };
  const byEvent = new Map(parts.triggers.map((spec) => [eventNameOf(fromComposio(spec)), spec]));
  const prefix = `${PROVIDER_EVENT_PREFIX}${catalog.source}.`;
  return {
    source: catalog.source,
    catalog,
    events: [...byEvent.keys()],
    viaComposioWebhook: true,
    async connected(env) {
      if (!(await env.composio.signedIn().catch(() => false))) return false;
      const accounts = await env.composio.accounts().catch(() => []);
      return accounts.some((a) => a.toolkit === catalog.source && a.status === "ACTIVE");
    },
    account: (env) => parts.account(env, service),
    async ensure(env, { kinds, dryRun }) {
      const specs = [
        ...new Set(
          catalog.kinds
            .filter((kind) => kinds.includes(kind.kind))
            .flatMap((kind) => kind.triggers)
            .map((trigger) => byEvent.get(eventNameOf(trigger)))
            .filter((spec) => spec !== undefined),
        ),
      ];
      if (specs.length === 0) {
        return { ok: false, error: `None of these kinds can be followed on ${catalog.label}.` };
      }
      return env.composio.ensureTriggers(service, specs, dryRun);
    },
    async ensureEvent(env, { eventName, dryRun }) {
      const spec = byEvent.get(eventName);
      if (!spec) return { ok: false, error: `${catalog.label} does not deliver ${eventName}.` };
      return env.composio.ensureTriggers(service, [spec], dryRun);
    },
    async normalize(env, { eventName, payload, account, kinds }) {
      if (!eventName.startsWith(prefix)) return null;
      return parts.normalize(env, {
        type: eventName.slice(prefix.length),
        payload,
        account,
        kinds: new Set(kinds),
        service,
      });
    },
  };
}
