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
import type { LinearViewer, NotionMe, WatchReads } from "./reads.js";
import type { WatchSourceDeps } from "./sources.js";

/** A GitHub login changes only with the token, so one read per token is enough. */
const githubLogins = new Map<string, string>();
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

/** A request to a connected service's own API, made through Composio with its account. */
export interface ComposioRequest {
  endpoint: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** One read from a connected service's API, or why it failed. */
export async function composioRead(
  toolkit: string,
  request: ComposioRequest,
): Promise<Record<string, unknown>> {
  const { client, id } = await composioAccountId(toolkit);
  const res = await client.proxyTool({
    connectedAccountId: id,
    endpoint: request.endpoint,
    method: request.method ?? "GET",
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.query ? { query: request.query } : {}),
  });
  if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== "object") {
    throw new Error(`${labelOf(toolkit)} answered ${res.status}`);
  }
  return res.data as Record<string, unknown>;
}

/** Identities change only with the connection, so one read per account is enough. */
const identities = new Map<string, unknown>();

async function identityOf<T>(toolkit: string, read: () => Promise<T>): Promise<T> {
  const { id } = await composioAccountId(toolkit);
  const key = `${toolkit}:${id}`;
  if (identities.has(key)) return identities.get(key) as T;
  const value = await read();
  identities.set(key, value);
  return value;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** A value the identity read must find, lower-cased when it is an address. */
const required = (toolkit: string, value: string | undefined): string => {
  if (!value) throw new Error(`${labelOf(toolkit)} did not say who is connected`);
  return value;
};

export const gmailAddress = () =>
  identityOf("gmail", async () => {
    const data = await composioRead("gmail", {
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    return required("gmail", text(data.emailAddress)?.toLowerCase());
  });

/** The primary calendar's id, which Google sets to the account's address. */
export const calendarAddress = () =>
  identityOf("googlecalendar", async () => {
    const data = await composioRead("googlecalendar", {
      endpoint: "https://www.googleapis.com/calendar/v3/calendars/primary",
    });
    return required("googlecalendar", text(data.id)?.toLowerCase());
  });

export const outlookAddress = () =>
  identityOf("outlook", async () => {
    const data = await composioRead("outlook", { endpoint: "https://graph.microsoft.com/v1.0/me" });
    return required("outlook", (text(data.mail) ?? text(data.userPrincipalName))?.toLowerCase());
  });

/** Linear answers GraphQL errors with a 200, so the errors are read here. */
async function linearQuery(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await composioRead("linear", {
    endpoint: "https://api.linear.app/graphql",
    method: "POST",
    body: { query, variables },
  });
  const errors = Array.isArray(res.errors) ? res.errors : [];
  if (errors.length > 0) {
    throw new Error(`Linear answered: ${text(record(errors[0]).message) ?? "an error"}`);
  }
  return record(res.data);
}

export const linearViewer = (): Promise<LinearViewer> =>
  identityOf("linear", async () => {
    const viewer = record(
      (await linearQuery("query { viewer { id name displayName email } }")).viewer,
    );
    return {
      id: required("linear", text(viewer.id)),
      ...(text(viewer.name) ? { name: text(viewer.name) } : {}),
      ...(text(viewer.displayName) ? { displayName: text(viewer.displayName) } : {}),
      ...(text(viewer.email) ? { email: text(viewer.email)?.toLowerCase() } : {}),
    };
  });

const NOTION_HEADERS = { "Notion-Version": "2022-06-28" };
const notionRead = (path: string, query?: Record<string, string>) =>
  composioRead("notion", {
    endpoint: `https://api.notion.com/v1/${path}`,
    headers: NOTION_HEADERS,
    ...(query ? { query } : {}),
  });

/** The person who connected Notion: the owner of Rome's integration in their workspace. */
export const notionMe = (): Promise<NotionMe> =>
  identityOf("notion", async () => {
    const me = await notionRead("users/me");
    const owner = record(record(record(me.bot).owner).user);
    const id = text(owner.id) ?? (text(me.type) === "person" ? text(me.id) : undefined);
    return {
      id: required("notion", id),
      ...(text(record(owner.person).email)
        ? { email: text(record(owner.person).email)?.toLowerCase() }
        : {}),
      ...(text(owner.name) ? { name: text(owner.name) } : {}),
      ...(text(record(me.bot).workspace_name)
        ? { workspace: text(record(me.bot).workspace_name) }
        : {}),
    };
  });

/** The connected Stripe account, by the name its dashboard shows. */
export const stripeAccountName = () =>
  identityOf("stripe", async () => {
    const account = await composioRead("stripe", { endpoint: "https://api.stripe.com/v1/account" });
    return required(
      "stripe",
      text(record(record(account.settings).dashboard).display_name) ??
        text(record(account.business_profile).name) ??
        text(account.email) ??
        text(account.id),
    );
  });

/** The reads normalizing an event may need, bound to the connected accounts. */
export const watchReads: WatchReads = {
  linearViewer,
  async linearIssue(id) {
    const issue = record(
      (
        await linearQuery(
          "query ($id: String!) { issue(id: $id) { assignee { id } creator { id } subscribers { nodes { id } } } }",
          { id },
        )
      ).issue,
    );
    const nodes = record(issue.subscribers).nodes;
    return {
      ...(text(record(issue.assignee).id) ? { assigneeId: text(record(issue.assignee).id) } : {}),
      ...(text(record(issue.creator).id) ? { creatorId: text(record(issue.creator).id) } : {}),
      subscriberIds: (Array.isArray(nodes) ? nodes : [])
        .map((node) => text(record(node).id))
        .filter((id): id is string => id !== undefined),
    };
  },
  outlookMessage: (id) =>
    composioRead("outlook", {
      endpoint: `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}`,
      query: {
        $select:
          "id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,webLink,conversationId,inferenceClassification,importance,internetMessageHeaders",
      },
    }),
  notionMe,
  notionComment: (id) => notionRead(`comments/${encodeURIComponent(id)}`),
  async notionComments(blockId) {
    const list = await notionRead("comments", { block_id: blockId, page_size: "100" });
    return (Array.isArray(list.results) ? list.results : []).map(record);
  },
  notionPage: (id) => notionRead(`pages/${encodeURIComponent(id)}`),
};

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
    composioAccount: async (service) => {
      switch (service) {
        case "gmail":
          return gmailAddress();
        case "googlecalendar":
          return calendarAddress();
        case "outlook":
          return outlookAddress();
        case "linear": {
          const viewer = await linearViewer();
          return viewer.email ?? viewer.name ?? viewer.id;
        }
        case "notion": {
          const me = await notionMe();
          return me.email ?? me.name ?? me.id;
        }
        case "stripe":
          return stripeAccountName();
        default:
          throw new Error(`Rome does not know whose ${service} account is connected`);
      }
    },
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
