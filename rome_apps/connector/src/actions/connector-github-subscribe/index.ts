import { randomBytes } from "node:crypto";

import { Octokit } from "@octokit/rest";
import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { readGithubOAuthToken } from "../../api/github-proxy.js";
import { resolveInstanceWebhookUrl } from "../../api/github-webhook.js";
import { resolveRelayDepositUrl } from "../../api/relay-webhook.js";
import { SettingsStore } from "../../api/settings-store.js";
import { buildTopic } from "../../api/topic.js";
import { romeManagedConnectHint } from "../../shared.js";
import {
  createGithubHookClient,
  type GithubHookClient,
  type GithubHookMutationInput,
} from "../github-hook-client.js";
import { isNonRetryableUpdateFailure, unionGithubEvents } from "./github-webhook-helpers.js";
import { hasLegacyWebhook, migrateLegacyWebhook } from "./legacy-webhook-migration.js";

export { unionGithubEvents } from "./github-webhook-helpers.js";

const log = createAppLogger("connector_github_subscribe");

const inputSchema = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be 'owner/name'")
      .optional()
      .describe("Repository to subscribe to, as 'owner/name' (e.g. 'acme/widgets')"),
    org: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Organization to subscribe to (org-wide hook). Pass either repo OR org."),
    events: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        "GitHub event names to deliver, e.g. ['push', 'pull_request', 'issues']. Use ['*'] for all events.",
      ),
  })
  .refine((v) => Boolean(v.repo) !== Boolean(v.org), {
    message: "Pass exactly one of `repo` or `org`.",
  });

const MISSING_RELAY_ERROR =
  "This instance has no relay mailbox configured. Connect the instance to Rome Cloud or fix Relay health in Settings before subscribing to GitHub events.";

export interface SubscribeGithubWebhookInput {
  client: GithubHookClient;
  relayDepositUrl: string;
  legacyInstanceUrl: string | null;
  requestedEvents: string[];
  secret: string;
}

export interface SubscribeGithubWebhookResult {
  hookId: number;
  events: string[];
  created: boolean;
  migrated: boolean;
  deletedDuplicates: number;
}

export async function subscribeGithubWebhook(
  input: SubscribeGithubWebhookInput,
): Promise<SubscribeGithubWebhookResult> {
  const hooks = await input.client.listHooks();
  const mutation = (events: string[]): GithubHookMutationInput => ({
    active: true,
    events,
    config: {
      url: input.relayDepositUrl,
      content_type: "json",
      secret: input.secret,
      insecure_ssl: "0",
    },
  });

  if (hasLegacyWebhook({ hooks, legacyInstanceUrl: input.legacyInstanceUrl })) {
    const migrated = await migrateLegacyWebhook({
      client: input.client,
      hooks,
      legacyInstanceUrl: input.legacyInstanceUrl,
      relayDepositUrl: input.relayDepositUrl,
      requestedEvents: input.requestedEvents,
      secret: input.secret,
    });
    return {
      hookId: migrated.hookId,
      events: migrated.events,
      created: migrated.created,
      migrated: true,
      deletedDuplicates: migrated.deletedDuplicates,
    };
  }

  const relayHooks = hooks.filter((hook) => hook.config?.url === input.relayDepositUrl);

  if (relayHooks.length === 0) {
    const created = await input.client.createHook(mutation(input.requestedEvents));
    return {
      hookId: created.id,
      events: input.requestedEvents,
      created: true,
      migrated: false,
      deletedDuplicates: 0,
    };
  }

  const canonical = relayHooks[0];
  const nextEvents = unionGithubEvents(canonical.events, input.requestedEvents);
  let hookId = canonical.id;
  let created = false;
  try {
    const updated = await input.client.updateHook(canonical.id, mutation(nextEvents));
    hookId = updated.id;
  } catch (err) {
    if (!isNonRetryableUpdateFailure(err)) throw err;
    await input.client.deleteHook(canonical.id);
    try {
      const replacement = await input.client.createHook(mutation(nextEvents));
      hookId = replacement.id;
      created = true;
    } catch (createErr) {
      const message = createErr instanceof Error ? createErr.message : String(createErr);
      throw new Error(
        `GitHub webhook update deleted relay hook ${canonical.id} but failed to create the replacement relay hook: ${message}`,
      );
    }
  }

  let deletedDuplicates = 0;
  for (const hook of relayHooks) {
    if (hook.id === canonical.id) continue;
    await input.client.deleteHook(hook.id);
    deletedDuplicates += 1;
  }

  return {
    hookId,
    events: nextEvents,
    created,
    migrated: false,
    deletedDuplicates,
  };
}

/** What every GitHub hook call needs: the guardian's token and where Rome's
 * hooks deliver. Read-only. */
export interface GithubHookSetup {
  octokit: Octokit;
  relayDepositUrl: string;
  legacyInstanceUrl: string | null;
}

/** Resolve {@link GithubHookSetup}, or the readable reason it is missing. */
export async function resolveGithubHookSetup(
  deps: AppActionRuntimeDeps,
): Promise<{ ok: true; setup: GithubHookSetup } | { ok: false; error: string }> {
  // GitHub is Rome-managed (Rome Cloud OAuth), with no Composio involvement —
  // we register the hook with the guardian's own OAuth token and verify
  // deliveries ourselves. No `connector_login` / `connector_connect`.
  const token = await readGithubOAuthToken();
  if (!token) return { ok: false, error: romeManagedConnectHint("github") };
  const relayDepositUrl = await resolveRelayDepositUrl(deps.appContext.repositories.settings);
  if (!relayDepositUrl) return { ok: false, error: MISSING_RELAY_ERROR };
  return {
    ok: true,
    setup: {
      octokit: new Octokit({ auth: token }),
      relayDepositUrl,
      legacyInstanceUrl: resolveInstanceWebhookUrl(),
    },
  };
}

/** One HMAC secret per instance, shared by every GitHub hook Rome registers
 * and by the `/webhook` handler that verifies inbound deliveries. Minted on
 * first subscribe and reused thereafter so existing hooks keep verifying. */
export async function ensureGithubWebhookSecret(deps: AppActionRuntimeDeps): Promise<string> {
  const settings = new SettingsStore(deps.appContext.db);
  let secret = await settings.get("githubWebhookSecret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await settings.set("githubWebhookSecret", secret);
  }
  return secret;
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ repo, org, events }) => {
      const resolved = await resolveGithubHookSetup(deps);
      if (!resolved.ok) return { status: "error", error: resolved.error };
      const { octokit, relayDepositUrl, legacyInstanceUrl } = resolved.setup;
      const secret = await ensureGithubWebhookSecret(deps);

      try {
        const result = await subscribeGithubWebhook({
          client: createGithubHookClient(octokit, repo ? { repo } : { org: org as string }),
          relayDepositUrl,
          legacyInstanceUrl,
          requestedEvents: events,
          secret,
        });
        // The eventName a routine's event-bus trigger binds to, per event. A
        // wildcard ('*') has no fixed topic — each delivery fires its own
        // `github.<event>`, so we can't enumerate them ahead of time.
        const topics = result.events.includes("*")
          ? null
          : result.events.map((e) => buildTopic("github", e.toLowerCase()));
        return {
          status: "ok",
          data: {
            target: repo ?? org,
            hookId: result.hookId,
            events: result.events,
            topics,
            migrated: result.migrated,
            deletedDuplicates: result.deletedDuplicates,
            note: topics
              ? "Bind a routine's event-bus trigger to one of `topics`."
              : "Events fire as `provider:event:github.<event>` — bind a routine to the specific event you need.",
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("github webhook subscribe failed", { target: repo ?? org, error: message });
        return { status: "error", error: `GitHub webhook subscribe failed: ${message}` };
      }
    },
  });
}
