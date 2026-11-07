// GitHub: a repository's pull requests, reviews, comments, CI and
// assignments, through one webhook per repository. A follow names the
// repository; the guardian is the token's login.

import type { WatchAdapter, Watchable, WatchTrigger } from "../../types.js";
import { ensureGithubFollow, ensureGithubWait, GITHUB_EVENT_PREFIX } from "./ensure.js";
import { normalizeGithub } from "./normalize.js";
import { liveGithubDeps } from "./runtime.js";

const repo = (type: string): WatchTrigger => ({
  provider: "github",
  type,
  filter: [{ field: "repository.full_name", equals: "{target}" }],
});

export const GITHUB_WATCHABLE: Watchable = {
  source: "github",
  label: "GitHub",
  target: { format: "A repository as owner/name", example: "rome-os/rome" },
  // Each kind is a shape of event, whoever it concerns: whether it is about
  // the guardian is a fact on the event, read when it is triaged.
  kinds: [
    {
      kind: "review_requested",
      label: "Review requests",
      default: true,
      triggers: [repo("pull_request")],
    },
    {
      kind: "review_on_your_pr",
      label: "Reviews of pull requests",
      default: true,
      triggers: [repo("pull_request_review")],
    },
    {
      kind: "comment_or_mention",
      label: "Comments on pull requests and issues",
      default: true,
      triggers: [repo("issue_comment"), repo("pull_request_review_comment")],
    },
    {
      kind: "your_ci_failed",
      label: "Failed CI runs",
      default: true,
      triggers: [repo("workflow_run")],
    },
    {
      kind: "your_pr_closed",
      label: "Pull requests merged or closed",
      default: true,
      triggers: [repo("pull_request")],
    },
    {
      kind: "assigned_to_you",
      label: "Assignments",
      default: true,
      triggers: [repo("issues"), repo("pull_request")],
    },
    {
      kind: "new_pr_or_issue",
      label: "New pull requests and issues",
      default: false,
      triggers: [repo("issues"), repo("pull_request")],
    },
  ],
  // The guardian's explicit wishes, stored as structured values. A follower
  // renders them in words for its triage, as guidance, never as filters.
  options: [
    {
      key: "scope",
      label: "What to hear about",
      type: "enum",
      values: [
        { value: "about_me", label: "Only what concerns me" },
        { value: "whole_repo", label: "Also the whole repository" },
      ],
      default: "about_me",
    },
    {
      key: "ignorePeople",
      label: "Ignore these people",
      type: "list",
      default: [],
      itemHint: "GitHub logins",
    },
    {
      key: "onlyPeople",
      label: "Only these people",
      type: "list",
      default: [],
      itemHint: "GitHub logins; empty means everyone",
    },
    {
      key: "includeBots",
      label: "Include bots",
      type: "boolean",
      default: false,
    },
  ],
};

/** What the GitHub adapter reads, injected so tests need no token. */
export interface GithubDeps {
  token(): Promise<string | null>;
  login(token: string): Promise<string>;
  /** Whether `login` is an active member of `org/teamSlug`. */
  isTeamMember(org: string, teamSlug: string, login: string): Promise<boolean>;
}

export function createGithubAdapter(deps: GithubDeps = liveGithubDeps): WatchAdapter {
  return {
    source: GITHUB_WATCHABLE.source,
    catalog: GITHUB_WATCHABLE,
    events: [`${GITHUB_EVENT_PREFIX}*`],
    connected: async () => (await deps.token().catch(() => null)) !== null,
    account: async () => deps.login((await deps.token()) ?? ""),
    ensure: (env, input) => ensureGithubFollow(env.app, GITHUB_WATCHABLE, input),
    ensureEvent: (env, input) => ensureGithubWait(env.app, input),
    async normalize(_env, { eventName, payload, account, kinds }) {
      if (!eventName.startsWith(GITHUB_EVENT_PREFIX)) return null;
      return normalizeGithub(eventName.slice(GITHUB_EVENT_PREFIX.length), payload, {
        login: account,
        kinds: new Set(kinds),
        isTeamMember: (org, slug) => deps.isTeamMember(org, slug, account),
      });
    },
  };
}
