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
import { romeManagedConnectHint } from "../../shared.js";
import { withGithubHookLock } from "../github-hook-lock.js";
import {
  createGithubHookClient,
  type GithubHook,
  type GithubHookDeleteClient,
} from "../github-hook-client.js";

const log = createAppLogger("connector_github_unsubscribe");

const inputSchema = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be 'owner/name'")
      .optional()
      .describe("Repository to unsubscribe, as 'owner/name' (e.g. 'acme/widgets')"),
    org: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Organization to unsubscribe (org-wide hook). Pass either repo OR org."),
  })
  .refine((v) => Boolean(v.repo) !== Boolean(v.org), {
    message: "Pass exactly one of `repo` or `org`.",
  });

export async function unsubscribeGithubWebhook(
  client: GithubHookDeleteClient,
  urls: string[],
): Promise<number> {
  const matchUrls = new Set(urls.filter((url) => url.length > 0));
  if (matchUrls.size === 0) return 0;
  const hooks = await client.listHooks();
  const ours = hooks.filter((hook) => {
    const url = hook.config?.url;
    return typeof url === "string" && matchUrls.has(url);
  });
  for (const hook of ours) {
    await client.deleteHook(hook.id);
  }
  return ours.length;
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ repo, org }) => {
      const token = await readGithubOAuthToken();
      if (!token) {
        return { status: "error", error: romeManagedConnectHint("github") };
      }

      const relayDepositUrl = await resolveRelayDepositUrl(deps.appContext.repositories.settings);
      const legacyInstanceUrl = resolveInstanceWebhookUrl();
      const urls = [relayDepositUrl, legacyInstanceUrl].filter((url): url is string =>
        Boolean(url),
      );

      const octokit = new Octokit({ auth: token });
      try {
        // List every hook, then keep only exact URL matches for Rome's relay or
        // legacy direct URL — never touch a hook the guardian added by hand or
        // another tool owns.
        const target = repo ? { repo } : { org: org as string };
        const deleted = await withGithubHookLock(deps.appContext.db, target, () =>
          unsubscribeGithubWebhook(createGithubHookClient(octokit, target), urls),
        );

        // Idempotent teardown: removing zero hooks is success (already gone), not
        // an error — mirrors the Composio disconnect's `deleted: 0` posture.
        return {
          status: "ok",
          data: {
            target: repo ?? org,
            deleted,
            note:
              deleted > 0
                ? `Removed ${deleted} Rome-registered GitHub webhook(s).`
                : "No Rome-registered GitHub webhook was found — nothing to remove.",
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("github webhook unsubscribe failed", { target: repo ?? org, error: message });
        return { status: "error", error: `GitHub webhook unsubscribe failed: ${message}` };
      }
    },
  });
}
