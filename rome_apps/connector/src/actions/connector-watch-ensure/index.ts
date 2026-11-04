import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { watchableOf } from "../../watch/catalog.js";
import { ensureGmailTrigger } from "../../watch/runtime.js";
import {
  describeGithubError,
  ensureGithubEvent,
  GithubTargetCaseError,
} from "../connector-event-ensure/index.js";
import {
  ensureGithubWebhookSecret,
  resolveGithubHookSetup,
} from "../connector-github-subscribe/index.js";
import { createGithubHookClient } from "../github-hook-client.js";

const log = createAppLogger("connector_watch_ensure");

const GITHUB_PREFIX = "provider:event:github.";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const inputSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().optional(),
  kinds: z.array(z.string()).min(1),
  dryRun: z.boolean().default(false),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ source, target, kinds, dryRun }) => {
      const watchable = watchableOf(source);
      if (!watchable) return { status: "error", error: `Rome cannot watch "${source}".` };
      if (source === "gmail") {
        const result = await ensureGmailTrigger(deps, dryRun);
        return result.ok
          ? { status: "ok", data: { subscription: result.subscription } }
          : { status: "error", error: result.error };
      }
      const repo = target ?? "";
      if (!REPO_PATTERN.test(repo)) {
        return {
          status: "error",
          error: `A GitHub follow needs a repository as owner/name, not "${repo}".`,
        };
      }
      const events = [
        ...new Set(
          watchable.kinds
            .filter((kind) => kinds.includes(kind.kind))
            .flatMap((kind) => kind.triggers.map((trigger) => trigger.eventName))
            .filter((name) => name.startsWith(GITHUB_PREFIX))
            .map((name) => name.slice(GITHUB_PREFIX.length)),
        ),
      ];
      const resolved = await resolveGithubHookSetup(deps);
      if (!resolved.ok) return { status: "error", error: resolved.error };
      const { octokit, relayDepositUrl, legacyInstanceUrl } = resolved.setup;
      const client = createGithubHookClient(octokit, { repo });
      const [owner, name] = repo.split("/") as [string, string];
      const states: string[] = [];
      try {
        for (const event of events) {
          states.push(
            await ensureGithubEvent({
              client,
              targetName: repo,
              targetField: "repository.full_name",
              canonicalName: async () =>
                (await octokit.rest.repos.get({ owner, repo: name })).data.full_name,
              relayDepositUrl,
              legacyInstanceUrl,
              event,
              dryRun,
              secret: () => ensureGithubWebhookSecret(deps),
            }),
          );
        }
      } catch (err) {
        const error =
          err instanceof GithubTargetCaseError ? err.message : describeGithubError(repo, err);
        log.warn("watch ensure refused", { repo, error });
        return { status: "error", error };
      }
      const subscription = dryRun
        ? states.every((state) => state === "active")
          ? "active"
          : "inactive"
        : states.includes("created")
          ? "created"
          : "existing";
      return { status: "ok", data: { subscription } };
    },
  });
}
