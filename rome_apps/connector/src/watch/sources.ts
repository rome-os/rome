// What this app adds to Rome's list of services, for followers such as the
// Concierge: the Composio services it connects (from the same catalog and
// account list as Settings → Connections reads through this app's API), and
// the watch section of each service it can watch. Rome's own connections
// (GitHub, Slack, Shopify and the chat channels) come from core.

import { CATALOG } from "../catalog.js";
import { eventNameOf, type Watchable, WATCHABLES } from "./catalog.js";

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
  /** Whose account the events concern: the GitHub login, the mailbox address. */
  account?: string;
  target: Watchable["target"];
  /** The kinds, each trigger with the bus name of its raw event for the follower's routines. */
  kinds: (Omit<Watchable["kinds"][number], "triggers"> & {
    triggers: (Watchable["kinds"][number]["triggers"][number] & { eventName: string })[];
  })[];
  options: Watchable["options"];
}

/** What the statuses read, injected so tests need no token, relay or Composio. */
export interface WatchSourceDeps {
  githubToken(): Promise<string | null>;
  relayDepositUrl(): Promise<string | null>;
  githubLogin(token: string): Promise<string>;
  /** False when Rome is not signed in to Composio. */
  composioSignedIn(): Promise<boolean>;
  /** Composio's connected accounts, as this app's `GET /connectors` lists them. */
  composioAccounts(): Promise<{ toolkit: string; status: string }[]>;
  /** The connected Gmail account's address. */
  gmailAddress(): Promise<string>;
}

export const NO_RELAY_REASON =
  "This Rome has no relay mailbox, so outside events cannot reach it. Connect it to Rome Cloud, or fix Relay health in Settings.";

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
  deps: WatchSourceDeps,
  watchable: Watchable,
  connected: boolean,
): Promise<WatchSection> {
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
  if (!(await deps.relayDepositUrl())) {
    return { ...base, status: "no_relay", statusReason: NO_RELAY_REASON };
  }
  try {
    const account =
      watchable.source === "github"
        ? await deps.githubLogin((await deps.githubToken()) ?? "")
        : await deps.gmailAddress();
    return { ...base, status: "ready", account };
  } catch (error) {
    return {
      ...base,
      status: "error",
      statusReason: `${watchable.label} did not say which account is connected: ${message(error)}`,
    };
  }
}

/** The Composio services, and the watch section of every service this app can watch. */
export async function listWatchSources(
  deps: WatchSourceDeps,
): Promise<{ services: ComposioService[]; watch: WatchSection[] }> {
  const signedIn = await deps.composioSignedIn().catch(() => false);
  const accounts = signedIn ? await deps.composioAccounts().catch(() => []) : [];
  const services = composioServices(accounts, signedIn);
  const watch: WatchSection[] = [];
  for (const watchable of WATCHABLES) {
    const connected =
      watchable.source === "github"
        ? (await deps.githubToken().catch(() => null)) !== null
        : services.some((s) => s.service === watchable.source && s.state === "working");
    watch.push(await watchSection(deps, watchable, connected));
  }
  return { services, watch };
}
