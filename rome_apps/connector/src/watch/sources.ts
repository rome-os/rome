// Which sources the guardian's connections let Rome watch now, and why not when
// they cannot: every watchable with its status, plus every other connected app
// as not supported, so a follower can tell the guardian what is missing.

import { CATALOG } from "../catalog.js";
import { type Watchable, WATCHABLES } from "./catalog.js";

export type WatchStatus = "ready" | "not_connected" | "no_relay" | "not_supported" | "error";

export interface WatchSource {
  source: string;
  label: string;
  status: WatchStatus;
  /** What is missing and how to fix it, when the status is not ready. */
  statusReason?: string;
  /** Who events are judged for: the GitHub login, the mailbox address. */
  account?: string;
  target: Watchable["target"];
  kinds: Watchable["kinds"];
  options: Watchable["options"];
}

/** What the statuses read, injected so tests need no token, relay or Composio. */
export interface WatchSourceDeps {
  githubToken(): Promise<string | null>;
  relayDepositUrl(): Promise<string | null>;
  githubLogin(token: string): Promise<string>;
  /** False when Rome is not signed in to Composio. */
  composioSignedIn(): Promise<boolean>;
  /** Active Composio connections by toolkit slug. */
  composioToolkits(): Promise<string[]>;
  /** The connected Gmail account's address. */
  gmailAddress(): Promise<string>;
  /** Rome-managed connections other than GitHub, by toolkit slug. */
  romeManagedToolkits(): Promise<string[]>;
}

export const NO_RELAY_REASON =
  "This Rome has no relay mailbox, so outside events cannot reach it. Connect it to Rome Cloud, or fix Relay health in Settings.";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const base = (watchable: Watchable) => ({
  source: watchable.source,
  label: watchable.label,
  target: watchable.target,
  kinds: watchable.kinds,
  options: watchable.options,
});

async function githubSource(deps: WatchSourceDeps, watchable: Watchable): Promise<WatchSource> {
  const token = await deps.githubToken();
  if (!token) {
    return {
      ...base(watchable),
      status: "not_connected",
      statusReason: "GitHub is not connected. Connect it in Settings → Connections.",
    };
  }
  if (!(await deps.relayDepositUrl())) {
    return { ...base(watchable), status: "no_relay", statusReason: NO_RELAY_REASON };
  }
  try {
    return { ...base(watchable), status: "ready", account: await deps.githubLogin(token) };
  } catch (error) {
    return {
      ...base(watchable),
      status: "error",
      statusReason: `GitHub did not say who the connected account is: ${message(error)}`,
    };
  }
}

async function gmailSource(
  deps: WatchSourceDeps,
  watchable: Watchable,
  toolkits: string[],
): Promise<WatchSource> {
  if (!(await deps.composioSignedIn())) {
    return {
      ...base(watchable),
      status: "not_connected",
      statusReason: "Gmail is not connected. Connect it in Settings → Connections.",
    };
  }
  if (!toolkits.includes("gmail")) {
    return {
      ...base(watchable),
      status: "not_connected",
      statusReason: "Gmail is not connected. Connect it in Settings → Connections.",
    };
  }
  if (!(await deps.relayDepositUrl())) {
    return { ...base(watchable), status: "no_relay", statusReason: NO_RELAY_REASON };
  }
  try {
    return { ...base(watchable), status: "ready", account: await deps.gmailAddress() };
  } catch (error) {
    return {
      ...base(watchable),
      status: "error",
      statusReason: `Gmail did not say which mailbox is connected: ${message(error)}`,
    };
  }
}

const nameOf = (slug: string) => CATALOG.find((entry) => entry.slug === slug)?.name ?? slug;

/** Every watchable with its status, then every other connected app as not supported. */
export async function listWatchSources(deps: WatchSourceDeps): Promise<WatchSource[]> {
  const signedIn = await deps.composioSignedIn().catch(() => false);
  const composio = signedIn ? await deps.composioToolkits().catch(() => []) : [];
  const sources: WatchSource[] = [];
  for (const watchable of WATCHABLES) {
    sources.push(
      watchable.source === "github"
        ? await githubSource(deps, watchable)
        : await gmailSource(
            { ...deps, composioSignedIn: async () => signedIn },
            watchable,
            composio,
          ),
    );
  }
  const watched = new Set(WATCHABLES.map((w) => w.source));
  const others = [...new Set([...composio, ...(await deps.romeManagedToolkits().catch(() => []))])]
    .filter((slug) => !watched.has(slug))
    .sort();
  for (const slug of others) {
    sources.push({
      source: slug,
      label: nameOf(slug),
      status: "not_supported",
      statusReason: `${nameOf(slug)} is connected, but Rome cannot follow it yet.`,
      target: null,
      kinds: [],
      options: [],
    });
  }
  return sources;
}
