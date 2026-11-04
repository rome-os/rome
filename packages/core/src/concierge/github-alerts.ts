// Which GitHub events the Concierge hears of, and how one reads as an alert.
// The routine trigger narrows each event type by repo and action; the checks
// here, which need the guardian's login, drop the rest before any model sees it.

import type { ConciergeFollowKind } from "@rome/api-types/concierge";
import type { EventFilterCondition } from "../routines/types.js";
import type { AlertEvent } from "./alerts.js";

export const GITHUB_EVENT_PREFIX = "provider:event:github.";
const REPO_FIELD = "repository.full_name";
const EXCERPT_CHARS = 300;

export interface GithubAlertType {
  /** GitHub's event name, such as `pull_request`. */
  type: ConciergeFollowKind<"github">;
  /** Conditions the routine trigger checks beyond the repo. */
  filter: EventFilterCondition[];
}

export const GITHUB_ALERT_TYPES: GithubAlertType[] = [
  { type: "pull_request", filter: [{ field: "action", equals: "review_requested" }] },
  { type: "pull_request_review", filter: [{ field: "action", equals: "submitted" }] },
  { type: "issue_comment", filter: [{ field: "action", equals: "created" }] },
  { type: "pull_request_review_comment", filter: [{ field: "action", equals: "created" }] },
  {
    type: "workflow_run",
    filter: [
      { field: "action", equals: "completed" },
      { field: "workflow_run.conclusion", equals: "failure" },
    ],
  },
];

export function githubTriggerFilter(repo: string, type: GithubAlertType): EventFilterCondition[] {
  return [{ field: REPO_FIELD, equals: repo }, ...type.filter];
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
const loginOf = (user: unknown) => str(obj(user).login);
const sameLogin = (a: string | undefined, b: string) =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

function excerpt(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
}

function mentions(text: string | undefined, login: string): boolean {
  if (!text) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(text);
}

/**
 * The alert a GitHub event makes for the guardian whose login is `login`, or
 * null when it does not concern them. The guardian's own actions never alert.
 */
export function githubAlertOf(type: string, payload: Json, login: string): AlertEvent | null {
  const repo = str(obj(payload.repository).full_name) ?? "";
  const sender = obj(payload.sender);
  const actor = str(sender.login);
  // The guardian's own review request, review or comment is no news to them.
  // A failed run they triggered is: the sender of `workflow_run` is the one who pushed.
  if (type !== "workflow_run" && sameLogin(actor, login)) return null;
  const base = (
    kind: string,
    id: string,
    fields: Record<string, string | undefined>,
    text?: string,
  ) => {
    const clean: Record<string, string> = { repo };
    for (const [key, value] of Object.entries(fields)) if (value) clean[key] = value;
    if (actor) clean.actor = actor;
    if (str(sender.type) === "Bot") clean.actor_type = "bot";
    const quoted = excerpt(text);
    return {
      id: `github:${repo}:${id}`,
      source: "github",
      kind,
      fields: clean,
      ...(quoted ? { text: quoted } : {}),
    };
  };

  switch (type) {
    case "pull_request": {
      if (payload.action !== "review_requested") return null;
      if (!sameLogin(loginOf(payload.requested_reviewer), login)) return null;
      const pr = obj(payload.pull_request);
      return base("review_requested", `pr:${str(pr.number)}:review_requested`, {
        number: str(pr.number),
        title: str(pr.title),
        url: str(pr.html_url),
        author: loginOf(pr.user),
      });
    }
    case "pull_request_review": {
      if (payload.action !== "submitted") return null;
      const pr = obj(payload.pull_request);
      if (!sameLogin(loginOf(pr.user), login)) return null;
      const review = obj(payload.review);
      return base(
        "review_on_your_pr",
        `review:${str(review.id)}`,
        {
          number: str(pr.number),
          title: str(pr.title),
          url: str(review.html_url) ?? str(pr.html_url),
          state: str(review.state)?.toLowerCase(),
        },
        str(review.body),
      );
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      if (payload.action !== "created") return null;
      const comment = obj(payload.comment);
      const body = str(comment.body);
      const thread = type === "issue_comment" ? obj(payload.issue) : obj(payload.pull_request);
      const theirs = sameLogin(loginOf(thread.user), login);
      const mentioned = mentions(body, login);
      if (!theirs && !mentioned) return null;
      const isPr = type === "pull_request_review_comment" || "pull_request" in thread;
      return base(
        mentioned ? "mention" : isPr ? "comment_on_your_pr" : "comment_on_your_issue",
        `comment:${str(comment.id)}`,
        {
          number: str(thread.number),
          title: str(thread.title),
          url: str(comment.html_url),
          on: isPr ? "pull_request" : "issue",
        },
        body,
      );
    }
    case "workflow_run": {
      const run = obj(payload.workflow_run);
      if (payload.action !== "completed" || run.conclusion !== "failure") return null;
      // A run counts as the guardian's when they triggered it: their push or their PR's.
      if (
        !sameLogin(loginOf(run.triggering_actor), login) &&
        !sameLogin(loginOf(run.actor), login)
      ) {
        return null;
      }
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests.map(obj) : [];
      return base("ci_failed", `run:${str(run.id)}:${str(run.run_attempt) ?? "1"}`, {
        workflow: str(run.name),
        branch: str(run.head_branch),
        url: str(run.html_url),
        pr:
          prs
            .map((pr) => str(pr.number))
            .filter(Boolean)
            .join(",") || undefined,
        title: str(run.display_title),
      });
    }
    default:
      return null;
  }
}

/**
 * The login of the account behind the guardian's GitHub token, read from
 * GitHub's `/user` once per token. Null when no token is stored.
 */
export function githubLoginReader(
  readToken: () => Promise<string | null>,
  fetchFn: typeof fetch = fetch,
): () => Promise<string | null> {
  let cached: { token: string; login: string } | null = null;
  return async () => {
    const token = await readToken();
    if (!token) return null;
    if (cached?.token === token) return cached.login;
    const response = await fetchFn("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "rome-concierge",
      },
    });
    if (!response.ok) throw new Error(`GitHub /user answered ${response.status}`);
    const login = str(obj(await response.json()).login);
    if (!login) throw new Error("GitHub /user carried no login");
    cached = { token, login };
    return login;
  };
}
