// The live reads behind watching: tokens, the relay, Composio, and the
// connected accounts' identities. The pure parts sit in catalog.ts, normalize.ts
// and sources.ts; the watch actions bind them here.

import { Octokit } from "@octokit/rest";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import type { ActiveTrigger } from "../api/composio-client.js";
import { ensureComposioWebhookRegistered } from "../api/composio-webhook.js";
import { readGithubOAuthToken } from "../api/github-proxy.js";
import { resolveRelayDepositUrl } from "../api/relay-webhook.js";
import { SettingsStore } from "../api/settings-store.js";
import { loadConnectorClient, ROME_USER_ID, subscribeTriggerFeed } from "../shared.js";
import { type ComposioTriggerSpec, watchableOf } from "./catalog.js";
import type { WatchSourceDeps } from "./sources.js";

/** Identities change only with the connection, so one read per token or account is enough. */
const githubLogins = new Map<string, string>();
const gmailAddresses = new Map<string, string>();
const calendarAddresses = new Map<string, string>();
const teamMembers = new Map<string, { member: boolean; at: number }>();
const TEAM_CACHE_MS = 10 * 60_000;

export async function githubLoginFor(token: string): Promise<string> {
  const cached = githubLogins.get(token);
  if (cached) return cached;
  const { data } = await new Octokit({ auth: token }).rest.users.getAuthenticated();
  githubLogins.set(token, data.login);
  return data.login;
}

/** Whether `login` is an active member of `org/teamSlug`, read with the guardian's token. */
export async function isTeamMember(org: string, teamSlug: string, login: string): Promise<boolean> {
  const key = `${org}/${teamSlug}/${login}`.toLowerCase();
  const cached = teamMembers.get(key);
  if (cached && Date.now() - cached.at < TEAM_CACHE_MS) return cached.member;
  const token = await readGithubOAuthToken();
  if (!token) return false;
  let member = false;
  try {
    const { data } = await new Octokit({ auth: token }).rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: teamSlug,
      username: login,
    });
    member = data.state === "active";
  } catch {
    member = false;
  }
  teamMembers.set(key, { member, at: Date.now() });
  return member;
}

type ComposioClient = NonNullable<Awaited<ReturnType<typeof loadConnectorClient>>>;

/** A watched Composio toolkit's name, as the guardian reads it. */
const labelOf = (toolkit: string) => watchableOf(toolkit)?.label ?? toolkit;

async function composioAccountId(toolkit: string): Promise<{ client: ComposioClient; id: string }> {
  const client = await loadConnectorClient();
  if (!client) throw new Error("Rome is not signed in to Composio.");
  const resolved = await client.findActiveConnectedAccount(ROME_USER_ID, toolkit);
  if (resolved.kind !== "ok") {
    throw new Error(`No ${labelOf(toolkit)} account is connected.`);
  }
  return { client, id: resolved.id };
}

/**
 * Whether an active Composio trigger already delivers what a follow needs:
 * the spec's trigger, for the connected account, with this app's config. One
 * for another account or another config does not.
 */
export function armsWatch(
  trigger: ActiveTrigger,
  spec: ComposioTriggerSpec,
  accountId: string,
): boolean {
  if (trigger.triggerName.toUpperCase() !== spec.slug) return false;
  if (!trigger.connectedAccountIds.includes(accountId)) return false;
  return Object.entries(spec.config).every(
    ([key, value]) => JSON.stringify(trigger.triggerConfig[key]) === JSON.stringify(value),
  );
}

/** Reads one value from a Google API through the connected account, cached per account. */
async function googleIdentity(
  toolkit: string,
  endpoint: string,
  read: (data: Record<string, unknown>) => unknown,
  cache: Map<string, string>,
): Promise<string> {
  const { client, id } = await composioAccountId(toolkit);
  const cached = cache.get(id);
  if (cached) return cached;
  const res = await client.proxyTool({ connectedAccountId: id, endpoint, method: "GET" });
  const value =
    res.data && typeof res.data === "object"
      ? read(res.data as Record<string, unknown>)
      : undefined;
  if (res.status < 200 || res.status >= 300 || typeof value !== "string" || !value) {
    throw new Error(`${labelOf(toolkit)} answered ${res.status}`);
  }
  const lowered = value.toLowerCase();
  cache.set(id, lowered);
  return lowered;
}

export const gmailAddress = () =>
  googleIdentity(
    "gmail",
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    (data) => data.emailAddress,
    gmailAddresses,
  );

/** The primary calendar's id, which Google sets to the account's address. */
export const calendarAddress = () =>
  googleIdentity(
    "googlecalendar",
    "https://www.googleapis.com/calendar/v3/calendars/primary",
    (data) => data.id,
    calendarAddresses,
  );

export function watchSourceDeps(deps: AppActionRuntimeDeps): WatchSourceDeps {
  return {
    githubToken: () => readGithubOAuthToken(),
    relayDepositUrl: () => resolveRelayDepositUrl(deps.appContext.repositories.settings),
    githubLogin: githubLoginFor,
    composioSignedIn: async () => (await loadConnectorClient()) !== null,
    composioAccounts: async () => {
      const client = await loadConnectorClient();
      if (!client) return [];
      return (await client.listConnectedAccounts(ROME_USER_ID)).map((account) => ({
        toolkit: account.toolkitSlug.toLowerCase(),
        status: account.status.toUpperCase(),
      }));
    },
    gmailAddress,
    calendarAddress,
  };
}

/**
 * Checks, or arms, the Composio triggers of one toolkit for its connected
 * account. Arming also points Composio's webhook at this Rome's relay mailbox.
 * A check answers `active` only when every trigger is armed; arming answers
 * `created` when it armed any.
 */
export async function ensureComposioTriggers(
  deps: AppActionRuntimeDeps,
  toolkit: string,
  specs: readonly ComposioTriggerSpec[],
  dryRun: boolean,
): Promise<{ ok: true; subscription: string } | { ok: false; error: string }> {
  let account: Awaited<ReturnType<typeof composioAccountId>>;
  try {
    account = await composioAccountId(toolkit);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!(await resolveRelayDepositUrl(deps.appContext.repositories.settings))) {
    return {
      ok: false,
      error: `This Rome has no relay mailbox, so ${labelOf(toolkit)} events cannot reach it.`,
    };
  }
  const active = await account.client.listActiveTriggers();
  const missing = specs.filter(
    (spec) => !active.some((trigger) => armsWatch(trigger, spec, account.id)),
  );
  if (dryRun) return { ok: true, subscription: missing.length === 0 ? "active" : "inactive" };
  await ensureComposioWebhookRegistered({
    client: account.client,
    appSettings: new SettingsStore(deps.appContext.db),
    settings: deps.appContext.repositories.settings,
  });
  for (const spec of missing) {
    const result = await subscribeTriggerFeed(account.client, {
      slug: spec.slug,
      config: spec.config,
      expectedToolkit: toolkit,
      connectedAccountId: account.id,
    });
    if (!result.ok) return { ok: false, error: result.message };
  }
  return { ok: true, subscription: missing.length > 0 ? "created" : "existing" };
}
