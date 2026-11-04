// The live reads behind watching: tokens, the relay, Composio, and the
// connected accounts' identities. The pure parts sit in catalog.ts, judge.ts
// and sources.ts; the watch actions bind them here.

import { Octokit } from "@octokit/rest";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { ensureComposioWebhookRegistered } from "../api/composio-webhook.js";
import { readGithubOAuthToken } from "../api/github-proxy.js";
import { resolveRelayDepositUrl } from "../api/relay-webhook.js";
import { SettingsStore } from "../api/settings-store.js";
import { readShopifyOAuthToken } from "../api/shopify-proxy.js";
import { readSlackOAuthTokens } from "../api/slack-proxy.js";
import { loadConnectorClient, ROME_USER_ID, subscribeTriggerFeed } from "../shared.js";
import { GMAIL_TRIGGER_CONFIG, GMAIL_TRIGGER_SLUG } from "./catalog.js";
import type { WatchSourceDeps } from "./sources.js";

/** Identities change only with the connection, so one read per token or account is enough. */
const githubLogins = new Map<string, string>();
const gmailAddresses = new Map<string, string>();
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

async function gmailAccountId(): Promise<{
  client: NonNullable<Awaited<ReturnType<typeof loadConnectorClient>>>;
  id: string;
}> {
  const client = await loadConnectorClient();
  if (!client) throw new Error("Rome is not signed in to Composio.");
  const resolved = await client.findActiveConnectedAccount(ROME_USER_ID, "gmail");
  if (resolved.kind !== "ok") throw new Error("No Gmail account is connected.");
  return { client, id: resolved.id };
}

export async function gmailAddress(): Promise<string> {
  const { client, id } = await gmailAccountId();
  const cached = gmailAddresses.get(id);
  if (cached) return cached;
  const res = await client.proxyTool({
    connectedAccountId: id,
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    method: "GET",
  });
  const address = (res.data as { emailAddress?: unknown } | null)?.emailAddress;
  if (res.status < 200 || res.status >= 300 || typeof address !== "string" || !address) {
    throw new Error(`Gmail's profile answered ${res.status}`);
  }
  const lowered = address.toLowerCase();
  gmailAddresses.set(id, lowered);
  return lowered;
}

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
    romeManagedConnected: async (toolkit) => {
      if (toolkit === "github") return (await readGithubOAuthToken()) !== null;
      if (toolkit === "slack") return (await readSlackOAuthTokens()) !== null;
      if (toolkit === "shopify") return (await readShopifyOAuthToken()) !== null;
      return false;
    },
  };
}

/** Checks, or arms, the new-mail trigger. Arming also points Composio's webhook at this Rome's relay mailbox. */
export async function ensureGmailTrigger(
  deps: AppActionRuntimeDeps,
  dryRun: boolean,
): Promise<{ ok: true; subscription: string } | { ok: false; error: string }> {
  let account: Awaited<ReturnType<typeof gmailAccountId>>;
  try {
    account = await gmailAccountId();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!(await resolveRelayDepositUrl(deps.appContext.repositories.settings))) {
    return { ok: false, error: "This Rome has no relay mailbox, so mail events cannot reach it." };
  }
  const active = (await account.client.listActiveTriggers()).some(
    (trigger) => trigger.triggerName.toUpperCase() === GMAIL_TRIGGER_SLUG,
  );
  if (dryRun) return { ok: true, subscription: active ? "active" : "inactive" };
  await ensureComposioWebhookRegistered({
    client: account.client,
    appSettings: new SettingsStore(deps.appContext.db),
    settings: deps.appContext.repositories.settings,
  });
  if (active) return { ok: true, subscription: "existing" };
  const result = await subscribeTriggerFeed(account.client, {
    slug: GMAIL_TRIGGER_SLUG,
    config: GMAIL_TRIGGER_CONFIG,
    expectedToolkit: "gmail",
    connectedAccountId: account.id,
  });
  return result.ok ? { ok: true, subscription: "created" } : { ok: false, error: result.message };
}
