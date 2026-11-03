import type { Octokit } from "@octokit/rest";
import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { PROVIDER_EVENT_PREFIX } from "../../api/topic.js";
import {
  ensureGithubWebhookSecret,
  resolveGithubHookSetup,
  subscribeGithubWebhook,
} from "../connector-github-subscribe/index.js";
import {
  createGithubHookClient,
  type GithubHook,
  type GithubHookClient,
  type GithubHookTarget,
} from "../github-hook-client.js";

const log = createAppLogger("connector_event_ensure");

const GITHUB_EVENT_PREFIX = `${PROVIDER_EVENT_PREFIX}github.`;
const REPO_FIELD = "repository.full_name";
const ORG_FIELD = "organization.login";

const inputSchema = z.object({
  eventName: z
    .string()
    .trim()
    .min(1)
    .describe("Bus event name, e.g. 'provider:event:github.workflow_run'"),
  filter: z
    .array(z.object({ field: z.string().min(1), equals: z.string() }))
    .default([])
    .describe("The wait's equality conditions; one must name the repo or org"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Only check: return active | inactive and change nothing"),
});

/** The repo or org a GitHub wait targets, read from its filter. A repo is the
 * narrower target, so it wins when both are given. */
export function githubTargetFromFilter(
  filter: { field: string; equals: string }[],
): GithubHookTarget | null {
  const value = (field: string) => filter.find((c) => c.field === field)?.equals.trim();
  const repo = value(REPO_FIELD);
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) return { repo };
  const org = value(ORG_FIELD);
  if (org) return { org };
  return null;
}

/** Whether one of Rome's active relay hooks already delivers `event`. */
export function hooksDeliver(hooks: GithubHook[], relayDepositUrl: string, event: string): boolean {
  return hooks.some(
    (hook) =>
      hook.config?.url === relayDepositUrl &&
      hook.active !== false &&
      (hook.events?.includes(event) || hook.events?.includes("*")),
  );
}

/** A GitHub API refusal in words an agent can act on. GitHub answers 404, not
 * 403, to a token that may not manage a repo's hooks. */
export function describeGithubError(target: string, err: unknown): string {
  const status =
    typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  if (status === 403 || status === 404) {
    return `GitHub refused the webhook on ${target}: admin access is required, or it does not exist (HTTP ${status})`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `GitHub webhook on ${target} failed: ${message}`;
}

/** The filter names the target in a case GitHub's events never carry. */
export class GithubTargetCaseError extends Error {}

export interface EnsureGithubEventInput {
  client: GithubHookClient;
  /** The repo (`owner/name`) or org login as the wait's filter spells it. */
  targetName: string;
  /** GitHub's own spelling of the target, the value its events carry. */
  canonicalName: () => Promise<string>;
  /** The filter field that names the target. */
  targetField: string;
  relayDepositUrl: string;
  legacyInstanceUrl: string | null;
  /** GitHub event name, e.g. `workflow_run`. */
  event: string;
  dryRun: boolean;
  /** Read lazily so a check that changes nothing mints no secret. */
  secret: () => Promise<string>;
}

/** Check, or create, Rome's subscription to `event` on one repo or org. */
export async function ensureGithubEvent(
  input: EnsureGithubEventInput,
): Promise<"active" | "inactive" | "existing" | "created"> {
  // GitHub resolves names in any case, but a routine filter compares exactly,
  // so a wait on "Acme/Widgets" would subscribe and then never match.
  const canonical = await input.canonicalName();
  if (canonical !== input.targetName) {
    throw new GithubTargetCaseError(
      `GitHub spells ${input.targetName} as ${canonical}. Filter ${input.targetField} on "${canonical}"; events carry that exact value.`,
    );
  }
  const delivering = hooksDeliver(
    await input.client.listHooks(),
    input.relayDepositUrl,
    input.event,
  );
  if (input.dryRun) return delivering ? "active" : "inactive";
  if (delivering) return "existing";
  await subscribeGithubWebhook({
    client: input.client,
    relayDepositUrl: input.relayDepositUrl,
    legacyInstanceUrl: input.legacyInstanceUrl,
    requestedEvents: [input.event],
    secret: await input.secret(),
  });
  return "created";
}

async function readGithubCanonicalName(
  octokit: Octokit,
  target: GithubHookTarget,
): Promise<string> {
  if ("repo" in target) {
    const [owner, repo] = target.repo.split("/");
    return (await octokit.rest.repos.get({ owner, repo })).data.full_name;
  }
  return (await octokit.rest.orgs.get({ org: target.org })).data.login;
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ eventName, filter, dryRun }) => {
      if (!eventName.startsWith(GITHUB_EVENT_PREFIX)) {
        return {
          status: "error",
          error: `connector_event_ensure handles ${GITHUB_EVENT_PREFIX}* events only, not "${eventName}"`,
        };
      }
      const event = eventName.slice(GITHUB_EVENT_PREFIX.length);
      const target = githubTargetFromFilter(filter);
      if (!event || !target) {
        return {
          status: "error",
          error: `${eventName} needs a filter on ${REPO_FIELD} (owner/name) or ${ORG_FIELD}`,
        };
      }
      const targetName = "repo" in target ? target.repo : target.org;
      const targetField = "repo" in target ? REPO_FIELD : ORG_FIELD;

      const resolved = await resolveGithubHookSetup(deps);
      if (!resolved.ok) return { status: "error", error: resolved.error };
      const { octokit, relayDepositUrl, legacyInstanceUrl } = resolved.setup;
      try {
        const subscription = await ensureGithubEvent({
          client: createGithubHookClient(octokit, target),
          targetName,
          targetField,
          canonicalName: () => readGithubCanonicalName(octokit, target),
          relayDepositUrl,
          legacyInstanceUrl,
          event,
          dryRun,
          secret: () => ensureGithubWebhookSecret(deps),
        });
        if (subscription === "created") {
          log.info("github event subscribed", { target: targetName, event });
        }
        return { status: "ok", data: { subscription } };
      } catch (err) {
        const error =
          err instanceof GithubTargetCaseError ? err.message : describeGithubError(targetName, err);
        log.error("github event ensure failed", { target: targetName, event, error });
        return { status: "error", error };
      }
    },
  });
}
