// A GitHub webhook delivery in the common shape: who did it, whether it is
// about the guardian (their pull request, a review requested of them or their
// team, a mention), and labels for what else is known.

import { drop, labelsOf, obj, same, str } from "../../shared/event.js";
import { excerptOf, subjectOf } from "../../shared/text.js";
import type { AddressedTo, Json, Normalized } from "../../types.js";

const loginOf = (user: unknown) => str(obj(user).login);

export interface GithubContext {
  /** The guardian's GitHub login. */
  login: string;
  /** The kinds the follow has on. */
  kinds: ReadonlySet<string>;
  /** Whether the guardian belongs to a team, for a review requested of a team. */
  isTeamMember(org: string, teamSlug: string): Promise<boolean>;
}

function mentions(text: string | undefined, login: string): boolean {
  if (!text) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(text);
}

/** A GitHub delivery of `type` in the common shape, or why it is not one. */
export async function normalizeGithub(
  type: string,
  payload: Json,
  ctx: GithubContext,
): Promise<Normalized> {
  const { login } = ctx;
  const repository = obj(payload.repository);
  const repo = str(repository.full_name) ?? "";
  const sender = obj(payload.sender);
  const actor = str(sender.login);
  const bot = str(sender.type) === "Bot" || /\[bot\]$/i.test(actor ?? "");

  const event = (
    kind: string,
    id: string,
    fields: {
      subject?: string;
      url?: string;
      text?: string;
      addressedTo: AddressedTo;
      byYou?: boolean;
      labels: (string | false | undefined)[];
    },
  ): Normalized => {
    if (!ctx.kinds.has(kind)) return drop("not a kind this follow has on");
    const quoted = excerptOf(fields.text);
    const subject = subjectOf(fields.subject);
    return {
      keep: true,
      event: {
        id: `github:${repo}:${id}`,
        source: "github",
        kind,
        ...(actor ? { actor } : {}),
        ...(subject ? { subject } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(quoted ? { excerpt: quoted } : {}),
        byYou: fields.byYou ?? same(actor, login),
        addressedTo: fields.addressedTo,
        labels: labelsOf(bot && "bot", ...fields.labels),
      },
    };
  };

  switch (type) {
    case "pull_request":
    case "issues": {
      const item = obj(type === "pull_request" ? payload.pull_request : payload.issue);
      const number = str(item.number);
      const on = type === "pull_request" ? "pull-request" : "issue";
      const yours = same(loginOf(item.user), login);
      const shared = { subject: str(item.title), url: str(item.html_url) };
      // One pull request or issue sees the same action again (a second review
      // request, a close after a reopen, a re-assign). Its `updated_at` tells
      // those apart, and stays the same when GitHub redelivers one webhook.
      const at = str(item.updated_at);
      const when = at ? `:${at}` : "";
      if (type === "pull_request" && payload.action === "review_requested") {
        const reviewer = loginOf(payload.requested_reviewer);
        const team = str(obj(payload.requested_team).slug);
        const org = str(obj(payload.organization).login) ?? repo.split("/")[0] ?? "";
        const ofYou =
          same(reviewer, login) || (team !== undefined && (await ctx.isTeamMember(org, team)));
        return event(
          "review_requested",
          `pr:${number}:review_requested:${reviewer ?? team}${when}`,
          {
            ...shared,
            addressedTo: ofYou || yours ? "direct" : "other",
            labels: [on, "review-requested", team && "team-review"],
          },
        );
      }
      if (type === "pull_request" && payload.action === "closed") {
        return event("your_pr_closed", `pr:${number}:closed${when}`, {
          ...shared,
          addressedTo: yours ? "direct" : "other",
          labels: [on, item.merged === true ? "merged" : "closed"],
        });
      }
      if (payload.action === "assigned") {
        const toYou = same(loginOf(payload.assignee), login);
        return event(
          "assigned_to_you",
          `${on}:${number}:assigned:${loginOf(payload.assignee)}${when}`,
          {
            ...shared,
            addressedTo: toYou ? "direct" : "other",
            labels: [on, "assigned"],
          },
        );
      }
      if (payload.action === "opened") {
        return event("new_pr_or_issue", `${on}:${number}:opened`, {
          ...shared,
          text: str(item.body),
          addressedTo: mentions(str(item.body), login) ? "direct" : "other",
          labels: [on, "opened"],
        });
      }
      return drop(`GitHub ${type}.${String(payload.action)} is not a kind follows describe`);
    }
    case "pull_request_review": {
      if (payload.action !== "submitted") return drop("not a submitted review");
      const pr = obj(payload.pull_request);
      const review = obj(payload.review);
      const state = str(review.state)?.toLowerCase().replaceAll("_", "-") ?? "commented";
      return event("review_on_your_pr", `review:${str(review.id)}`, {
        subject: str(pr.title),
        url: str(review.html_url) ?? str(pr.html_url),
        text: str(review.body),
        addressedTo: same(loginOf(pr.user), login) ? "direct" : "other",
        labels: ["pull-request", "review", state],
      });
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      if (payload.action !== "created") return drop("not a new comment");
      const comment = obj(payload.comment);
      const body = str(comment.body);
      const thread = type === "issue_comment" ? obj(payload.issue) : obj(payload.pull_request);
      const isPr = type === "pull_request_review_comment" || "pull_request" in thread;
      const mentioned = mentions(body, login);
      return event("comment_or_mention", `comment:${str(comment.id)}`, {
        subject: str(thread.title),
        url: str(comment.html_url),
        text: body,
        addressedTo: mentioned || same(loginOf(thread.user), login) ? "direct" : "other",
        labels: [isPr ? "pull-request" : "issue", "comment", mentioned && "mention"],
      });
    }
    case "workflow_run": {
      const run = obj(payload.workflow_run);
      if (payload.action !== "completed" || run.conclusion !== "failure") {
        return drop("not a failed run");
      }
      const branch = str(run.head_branch);
      const triggeredByYou =
        same(loginOf(run.triggering_actor), login) || same(loginOf(run.actor), login);
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests.map(obj) : [];
      return event("your_ci_failed", `run:${str(run.id)}:${str(run.run_attempt) ?? "1"}`, {
        subject: str(run.display_title) ?? str(run.name),
        url: str(run.html_url),
        byYou: triggeredByYou,
        addressedTo: triggeredByYou ? "direct" : "other",
        labels: [
          "ci-failed",
          branch !== undefined && same(branch, str(repository.default_branch)) && "default-branch",
          prs.length > 0 && "pull-request",
        ],
      });
    }
    default:
      return drop(`GitHub ${type} is not a kind follows describe`);
  }
}
