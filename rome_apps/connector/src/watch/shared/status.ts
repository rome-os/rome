// What this app adds to Rome's list of services, for followers such as the
// Concierge: the Composio services it connects (from the same catalog and
// account list as Settings → Connections reads through this app's API), and
// the watch section of each service it can watch. Rome's own connections
// (GitHub, Slack, Shopify and the chat channels) come from core.

import { CATALOG } from "../../catalog.js";
import type { WatchAdapter, WatchEnv, WatchKind, Watchable, WatchTrigger } from "../types.js";
import { eventNameOf } from "./event.js";

export type WatchStatus = "ready" | "not_connected" | "no_relay" | "error";

/** How a client starts connecting a Composio service: one call on this Rome that answers `{ redirectUrl }`. */
export interface ComposioConnect {
  kind: "composio";
  method: "POST";
  path: string;
  body: { provider: string };
  /** Sign in to Composio first, with `login`, when Rome is not signed in. */
  needsLogin: boolean;
  login: { method: "POST"; path: string };
}

/** One Composio service, as Settings → Connections shows it. */
export interface ComposioService {
  service: string;
  label: string;
  glyph: string;
  /** `working`, `broken` when its access expired, or null when not connected. */
  state: "working" | "broken" | null;
  connect: ComposioConnect | null;
}

/** The watch section of a service this app can watch. */
export interface WatchSection {
  service: string;
  label: string;
  status: WatchStatus;
  /** What is missing and how to fix it, when the status is not ready. */
  statusReason?: string;
  /**
   * The kinds whose events are not arriving because their subscription at the
   * source is missing, with what to do. A follow with one of them on cannot
   * receive those events.
   */
  undelivered?: { kinds: string[]; reason: string };
  /** Whose account the events concern: the GitHub login, the mailbox address. */
  account?: string;
  target: Watchable["target"];
  /** The kinds, each trigger with the bus name of its raw event for the follower's routines. */
  kinds: (Omit<WatchKind, "triggers"> & { triggers: (WatchTrigger & { eventName: string })[] })[];
  options: Watchable["options"];
}

export const NO_RELAY_REASON =
  "This Rome has no relay mailbox, so outside events cannot reach it. Connect it to Rome Cloud, or fix Relay health in Settings.";

export const COMPOSIO_WEBHOOK_ELSEWHERE_REASON =
  "Events for this Composio project go to another Rome. Create a separate project for this Rome in Composio, then pick it under Composio in Settings → Connections. Or choose Set up again under Event delivery to take them back.";

export const COMPOSIO_TRIGGER_MISSING_REASON =
  "Composio is not sending these events: their trigger is missing or turned off there. Ask me to follow it again to fix it.";

const COMPOSIO_LOGIN = { method: "POST" as const, path: "/api/apps/connector/login/start" };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The Composio services, from the catalog Settings reads (`GET /catalog`) and its accounts (`GET /connectors`). */
export function composioServices(
  accounts: { toolkit: string; status: string }[],
  signedIn: boolean,
): ComposioService[] {
  return CATALOG.filter((entry) => entry.romeManaged !== true).map((entry) => {
    const states = accounts.filter((a) => a.toolkit === entry.slug).map((a) => a.status);
    const state = states.includes("ACTIVE")
      ? "working"
      : states.includes("EXPIRED")
        ? "broken"
        : null;
    return {
      service: entry.slug,
      label: entry.name,
      glyph: entry.glyph,
      state,
      connect:
        state === "working"
          ? null
          : {
              kind: "composio",
              method: "POST",
              path: "/api/apps/connector/connectors",
              body: { provider: entry.slug },
              needsLogin: !signedIn,
              login: COMPOSIO_LOGIN,
            },
    };
  });
}

async function watchSection(
  env: WatchEnv,
  adapter: WatchAdapter,
  connected: boolean,
): Promise<WatchSection> {
  const watchable = adapter.catalog;
  const base = {
    service: watchable.source,
    label: watchable.label,
    target: watchable.target,
    kinds: watchable.kinds.map((kind) => ({
      ...kind,
      triggers: kind.triggers.map((trigger) => ({ ...trigger, eventName: eventNameOf(trigger) })),
    })),
    options: watchable.options,
  };
  if (!connected) {
    return {
      ...base,
      status: "not_connected",
      statusReason: `${watchable.label} is not connected. Connect it in Settings → Connections.`,
    };
  }
  if (!(await env.relayDepositUrl())) {
    return { ...base, status: "no_relay", statusReason: NO_RELAY_REASON };
  }
  if (adapter.viaComposioWebhook && (await env.composio.webhookTarget()) === "elsewhere") {
    return { ...base, status: "error", statusReason: COMPOSIO_WEBHOOK_ELSEWHERE_REASON };
  }
  try {
    const account = await adapter.account(env);
    // Only Composio sources say which kinds are unarmed. When Composio cannot say, nothing is flagged.
    const unarmed = await adapter.unarmedKinds?.(env).catch(() => []);
    return {
      ...base,
      status: "ready",
      account,
      ...(unarmed && unarmed.length > 0
        ? { undelivered: { kinds: unarmed, reason: COMPOSIO_TRIGGER_MISSING_REASON } }
        : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      statusReason: `${watchable.label} did not say which account is connected: ${message(error)}`,
    };
  }
}

/** The Composio services, and the watch section of every source an adapter watches. */
export async function listWatchSources(
  adapters: readonly WatchAdapter[],
  env: WatchEnv,
): Promise<{ services: ComposioService[]; watch: WatchSection[] }> {
  const signedIn = await env.composio.signedIn().catch(() => false);
  const accounts = signedIn ? await env.composio.accounts().catch(() => []) : [];
  const services = composioServices(accounts, signedIn);
  // One read of Composio's sign-in, accounts, webhook and triggers serves every adapter.
  let target: ReturnType<WatchEnv["composio"]["webhookTarget"]> | undefined;
  let active: ReturnType<WatchEnv["composio"]["activeTriggers"]> | undefined;
  const once: WatchEnv = {
    ...env,
    composio: {
      ...env.composio,
      signedIn: async () => signedIn,
      accounts: async () => accounts,
      activeTriggers: () => {
        active ??= env.composio.activeTriggers();
        return active;
      },
      webhookTarget: () => {
        target ??= env.composio.webhookTarget().catch(() => "unknown" as const);
        return target;
      },
    },
  };
  const watch: WatchSection[] = [];
  for (const adapter of adapters) {
    const connected = await adapter.connected(once).catch(() => false);
    watch.push(await watchSection(once, adapter, connected));
  }
  return { services, watch };
}
