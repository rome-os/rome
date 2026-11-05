import { describe, expect, it } from "@rstest/core";
import { GITHUB_WATCHABLE } from "./index.js";
import { type GithubContext, normalizeGithub } from "./normalize.js";

const repository = { full_name: "acme/widgets", default_branch: "main" };
const me = "Octo-Me";
const ALL_KINDS = new Set(GITHUB_WATCHABLE.kinds.map((k) => k.kind));

const ctx = (extra: Partial<GithubContext> = {}): GithubContext => ({
  login: me,
  kinds: ALL_KINDS,
  isTeamMember: async () => false,
  ...extra,
});

const pr = (user = "alice") => ({
  number: 7,
  title: "Fix it",
  html_url: "https://github.com/acme/widgets/pull/7",
  user: { login: user },
});

const reviewRequest = (extra: Record<string, unknown> = {}) => ({
  action: "review_requested",
  repository,
  organization: { login: "acme" },
  sender: { login: "alice" },
  pull_request: pr(),
  ...extra,
});

describe("normalizeGithub", () => {
  it("gives a review request in the common shape, direct when it is of the guardian", async () => {
    const mine = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_reviewer: { login: "octo-me" } }),
      ctx(),
    );
    expect(mine).toEqual({
      keep: true,
      event: {
        id: "github:acme/widgets:pr:7:review_requested:octo-me",
        source: "github",
        kind: "review_requested",
        actor: "alice",
        subject: "Fix it",
        url: "https://github.com/acme/widgets/pull/7",
        byYou: false,
        addressedTo: "direct",
        labels: ["pull-request", "review-requested"],
      },
    });
    // A request of someone else is kept too, addressed to others: triage decides.
    const theirs = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_reviewer: { login: "bob" } }),
      ctx(),
    );
    expect(theirs).toMatchObject({ keep: true, event: { addressedTo: "other" } });
  });

  it("tells a second request, a re-close or a re-assign apart, and keeps a redelivery's id", async () => {
    const idOf = async (type: string, payload: Record<string, unknown>) => {
      const result = await normalizeGithub(type, payload, ctx());
      return result.keep ? result.event.id : undefined;
    };
    const at = (updatedAt: string) => ({ ...pr(), updated_at: updatedAt });
    const request = (updatedAt: string) =>
      reviewRequest({ requested_reviewer: { login: "octo-me" }, pull_request: at(updatedAt) });
    const first = await idOf("pull_request", request("2026-11-04T10:00:00Z"));
    // The same webhook delivered again keeps its id, so it is dropped as a repeat.
    expect(await idOf("pull_request", request("2026-11-04T10:00:00Z"))).toBe(first);
    // A second request on the same pull request is a new event.
    expect(await idOf("pull_request", request("2026-11-05T09:00:00Z"))).not.toBe(first);

    const close = (updatedAt: string) => ({
      action: "closed",
      repository,
      sender: { login: "bob" },
      pull_request: { ...at(updatedAt), merged: false },
    });
    expect(await idOf("pull_request", close("2026-11-04T11:00:00Z"))).not.toBe(
      await idOf("pull_request", close("2026-11-04T12:00:00Z")),
    );
    const assign = (updatedAt: string) => ({
      action: "assigned",
      repository,
      sender: { login: "bob" },
      assignee: { login: "octo-me" },
      issue: { number: 3, title: "Bug", user: { login: "alice" }, updated_at: updatedAt },
    });
    expect(await idOf("issues", assign("2026-11-04T11:00:00Z"))).not.toBe(
      await idOf("issues", assign("2026-11-04T13:00:00Z")),
    );
  });

  it("makes a request of a team the guardian is on direct", async () => {
    const result = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_team: { slug: "core" } }),
      ctx({ isTeamMember: async (org, slug) => org === "acme" && slug === "core" }),
    );
    expect(result).toMatchObject({
      keep: true,
      event: { addressedTo: "direct", labels: ["pull-request", "review-requested", "team-review"] },
    });
  });

  it("marks the guardian's own actions and bots, and a mention as direct", async () => {
    const comment = (sender: string, body: string, threadAuthor = "alice") =>
      normalizeGithub(
        "issue_comment",
        {
          action: "created",
          repository,
          sender: { login: sender },
          issue: { number: 3, title: "Bug", user: { login: threadAuthor } },
          comment: { id: 9, body, html_url: "https://x/c/9" },
        },
        ctx(),
      );
    expect(await comment("octo-me", "On it")).toMatchObject({
      keep: true,
      event: { byYou: true, addressedTo: "other", labels: ["issue", "comment"] },
    });
    expect(await comment("bob", "@octo-me can you look?")).toMatchObject({
      keep: true,
      event: { byYou: false, addressedTo: "direct", labels: ["issue", "comment", "mention"] },
    });
    expect(await comment("bob", "thanks", "octo-me")).toMatchObject({
      event: { addressedTo: "direct" },
    });
    const bot = await normalizeGithub(
      "pull_request",
      {
        action: "opened",
        repository,
        sender: { login: "dependabot[bot]", type: "Bot" },
        pull_request: pr("dependabot[bot]"),
      },
      ctx(),
    );
    expect(bot).toMatchObject({
      keep: true,
      event: { kind: "new_pr_or_issue", labels: ["bot", "pull-request", "opened"] },
    });
  });

  it("gives every failed run, by the guardian when they triggered it, with labels", async () => {
    const run = (triggerer: string, branch: string) => ({
      action: "completed",
      repository,
      sender: { login: triggerer },
      workflow_run: {
        id: 11,
        run_attempt: 2,
        name: "CI",
        display_title: "Fix it",
        conclusion: "failure",
        head_branch: branch,
        html_url: "https://github.com/acme/widgets/actions/runs/11",
        triggering_actor: { login: triggerer },
        pull_requests: [{ number: 7 }],
      },
    });
    expect(await normalizeGithub("workflow_run", run("octo-me", "fix"), ctx())).toMatchObject({
      keep: true,
      event: {
        id: "github:acme/widgets:run:11:2",
        kind: "your_ci_failed",
        byYou: true,
        addressedTo: "direct",
        labels: ["ci-failed", "pull-request"],
      },
    });
    expect(await normalizeGithub("workflow_run", run("bob", "main"), ctx())).toMatchObject({
      keep: true,
      event: {
        byYou: false,
        addressedTo: "other",
        labels: ["ci-failed", "default-branch", "pull-request"],
      },
    });
    const passed = run("bob", "main");
    passed.workflow_run.conclusion = "success";
    expect(await normalizeGithub("workflow_run", passed, ctx())).toEqual({
      keep: false,
      reason: "not a failed run",
    });
  });

  it("drops only a kind the follow has off, or a shape no kind describes", async () => {
    const closed = {
      action: "closed",
      repository,
      sender: { login: "bob" },
      pull_request: { ...pr("octo-me"), merged: true },
    };
    expect(await normalizeGithub("pull_request", closed, ctx())).toMatchObject({
      keep: true,
      event: { kind: "your_pr_closed", addressedTo: "direct", labels: ["pull-request", "merged"] },
    });
    expect(
      await normalizeGithub("pull_request", closed, ctx({ kinds: new Set(["review_requested"]) })),
    ).toEqual({ keep: false, reason: "not a kind this follow has on" });
    expect(
      await normalizeGithub("pull_request", { ...closed, action: "synchronize" }, ctx()),
    ).toMatchObject({ keep: false });
  });
});
