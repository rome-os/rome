import { describe, expect, it } from "@rstest/core";
import { GITHUB_WATCHABLE } from "./catalog.js";
import { addressesIn, type GithubJudgeContext, judgeGithub, judgeGmail } from "./judge.js";

const repository = { full_name: "acme/widgets", default_branch: "main" };
const me = "Octo-Me";
const ALL_KINDS = new Set(GITHUB_WATCHABLE.kinds.map((k) => k.kind));

const ctx = (extra: Partial<GithubJudgeContext> = {}): GithubJudgeContext => ({
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

describe("judgeGithub", () => {
  it("tells of a review requested of the guardian, in the common shape", async () => {
    const result = await judgeGithub(
      "pull_request",
      {
        action: "review_requested",
        repository,
        sender: { login: "alice" },
        requested_reviewer: { login: "octo-me" },
        pull_request: pr(),
      },
      ctx(),
    );
    expect(result).toEqual({
      relevant: true,
      event: {
        id: "github:acme/widgets:pr:7:review_requested:Octo-Me",
        source: "github",
        kind: "review_requested",
        actor: "alice",
        subject: "Fix it",
        url: "https://github.com/acme/widgets/pull/7",
        facts: { aboutMe: true },
        details: { repo: "acme/widgets", number: "7", on: "pull_request", author: "alice" },
      },
    });
  });

  it("tells of a review requested of a team the guardian is on, and not of another team", async () => {
    const payload = {
      action: "review_requested",
      repository,
      organization: { login: "acme" },
      sender: { login: "alice" },
      requested_team: { slug: "core" },
      pull_request: pr(),
    };
    const member = ctx({ isTeamMember: async (org, slug) => org === "acme" && slug === "core" });
    const result = await judgeGithub("pull_request", payload, member);
    expect(result).toMatchObject({ relevant: true, event: { facts: { team: "core" } } });
    const other = await judgeGithub("pull_request", payload, ctx());
    expect(other.relevant).toBe(false);
  });

  it("tells of the guardian's PR merged or closed, and of an assignment", async () => {
    const closed = await judgeGithub(
      "pull_request",
      {
        action: "closed",
        repository,
        sender: { login: "alice" },
        pull_request: { ...pr("octo-me"), merged: true },
      },
      ctx(),
    );
    expect(closed).toMatchObject({
      relevant: true,
      event: { kind: "your_pr_closed", facts: { outcome: "merged" } },
    });
    const assigned = await judgeGithub(
      "issues",
      {
        action: "assigned",
        repository,
        sender: { login: "alice" },
        assignee: { login: "octo-me" },
        issue: { number: 3, title: "Bug", user: { login: "bob" } },
      },
      ctx(),
    );
    expect(assigned).toMatchObject({ relevant: true, event: { kind: "assigned_to_you" } });
  });

  it("tells of new issues and failed default-branch runs only for the whole repository", async () => {
    const opened = {
      action: "opened",
      repository,
      sender: { login: "alice" },
      issue: { number: 4, title: "Idea", user: { login: "alice" }, body: "What if" },
    };
    expect((await judgeGithub("issues", opened, ctx())).relevant).toBe(false);
    const whole = ctx({ options: { scope: "whole_repo" } });
    expect(await judgeGithub("issues", opened, whole)).toMatchObject({
      relevant: true,
      event: { kind: "new_pr_or_issue", excerpt: "What if" },
    });
    const run = {
      action: "completed",
      repository,
      sender: { login: "bob" },
      workflow_run: {
        id: 9,
        conclusion: "failure",
        head_branch: "main",
        actor: { login: "bob" },
        triggering_actor: { login: "bob" },
      },
    };
    expect((await judgeGithub("workflow_run", run, ctx())).relevant).toBe(false);
    expect(await judgeGithub("workflow_run", run, whole)).toMatchObject({
      relevant: true,
      event: { kind: "default_branch_ci_failed" },
    });
  });

  it("tells of a failed run the guardian triggered, even though they sent it", async () => {
    const result = await judgeGithub(
      "workflow_run",
      {
        action: "completed",
        repository,
        sender: { login: "octo-me" },
        workflow_run: {
          id: 5,
          run_attempt: 2,
          name: "CI",
          conclusion: "failure",
          head_branch: "fix",
          actor: { login: "octo-me" },
          pull_requests: [{ number: 7 }],
        },
      },
      ctx({ options: { onlyPeople: ["alice"] } }),
    );
    expect(result).toMatchObject({
      relevant: true,
      event: { id: "github:acme/widgets:run:5:2", kind: "your_ci_failed", details: { pr: "7" } },
    });
  });

  it("drops the guardian's own actions, including what an app posts under their identity", async () => {
    const review = {
      action: "submitted",
      repository,
      sender: { login: "octo-me" },
      pull_request: pr("octo-me"),
      review: { id: 21, state: "COMMENTED", body: "Automated review" },
    };
    expect(await judgeGithub("pull_request_review", review, ctx())).toEqual({
      relevant: false,
      reason: "the guardian's own action",
    });
  });

  it("applies the people options: bots, ignored people, only people", async () => {
    const comment = (login: string, type?: string) => ({
      action: "created",
      repository,
      sender: { login, ...(type ? { type } : {}) },
      issue: { number: 3, title: "Bug", user: { login: "octo-me" } },
      comment: { id: 1, body: "Looks off" },
    });
    expect(
      (await judgeGithub("issue_comment", comment("dependabot[bot]", "Bot"), ctx())).relevant,
    ).toBe(false);
    expect(
      (
        await judgeGithub(
          "issue_comment",
          comment("dependabot[bot]", "Bot"),
          ctx({ options: { includeBots: true } }),
        )
      ).relevant,
    ).toBe(true);
    const ignoring = ctx({ options: { includeBots: true, ignorePeople: ["dependabot"] } });
    expect(await judgeGithub("issue_comment", comment("dependabot[bot]", "Bot"), ignoring)).toEqual(
      {
        relevant: false,
        reason: "from an ignored person",
      },
    );
    const only = ctx({ options: { onlyPeople: ["@bob"] } });
    expect((await judgeGithub("issue_comment", comment("alice"), only)).relevant).toBe(false);
    expect((await judgeGithub("issue_comment", comment("bob"), only)).relevant).toBe(true);
  });

  it("drops a kind the follow has off", async () => {
    const result = await judgeGithub(
      "pull_request",
      {
        action: "review_requested",
        repository,
        sender: { login: "alice" },
        requested_reviewer: { login: "octo-me" },
        pull_request: pr(),
      },
      ctx({ kinds: new Set(["your_ci_failed"]) }),
    );
    expect(result.relevant).toBe(false);
  });
});

const address = "me@example.com";
const mail = (extra: Record<string, unknown> = {}) => ({
  message_id: "m1",
  thread_id: "t1",
  sender: "Ana Lima <ana@x.io>",
  to: "Me <me@example.com>",
  subject: "Lunch on Friday?",
  preview: { subject: "Lunch on Friday?", body: "Are you free on Friday at noon?" },
  label_ids: ["INBOX", "UNREAD"],
  ...extra,
});
const withHeaders = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  mail({
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
    ...extra,
  });

describe("judgeGmail", () => {
  it("tells of mail a person sent the guardian", () => {
    expect(judgeGmail(mail(), { address })).toEqual({
      relevant: true,
      event: {
        id: "gmail:me@example.com:m1",
        source: "gmail",
        kind: "new_mail",
        actor: "Ana Lima <ana@x.io>",
        subject: "Lunch on Friday?",
        url: "https://mail.google.com/mail/u/0/#all/t1",
        excerpt: "Are you free on Friday at noon?",
        facts: { recipient: "to" },
        details: { mailbox: "me@example.com" },
      },
    });
  });

  it("marks cc-only mail, and drops it when the follow wants only direct mail", () => {
    const ccOnly = withHeaders({ Cc: "me@example.com" }, { to: "bo@y.io" });
    expect(judgeGmail(ccOnly, { address })).toMatchObject({
      relevant: true,
      event: { facts: { recipient: "cc" } },
    });
    expect(judgeGmail(ccOnly, { address, options: { recipients: "to" } })).toEqual({
      relevant: false,
      reason: "not sent to the guardian directly",
    });
  });

  it("drops Gmail's tabs, automated senders, list and bulk mail, and the guardian's own", () => {
    for (const label of [
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "CATEGORY_FORUMS",
      "CATEGORY_UPDATES",
    ]) {
      expect(judgeGmail(mail({ label_ids: ["INBOX", label] }), { address }).relevant).toBe(false);
    }
    expect(judgeGmail(mail({ label_ids: ["SENT"] }), { address }).relevant).toBe(false);
    for (const sender of [
      "noreply@github.com",
      "notifications@stripe.com",
      "do-not-reply+x@bank.example",
    ]) {
      expect(judgeGmail(mail({ sender }), { address }).relevant).toBe(false);
    }
    expect(judgeGmail(mail({ sender: "me@example.com" }), { address }).relevant).toBe(false);
    expect(
      judgeGmail(withHeaders({ "List-Unsubscribe": "<mailto:u@x.io>" }), { address }).relevant,
    ).toBe(false);
    expect(judgeGmail(withHeaders({ Precedence: "bulk" }), { address }).relevant).toBe(false);
  });

  it("keeps the Updates tab when the follow asks for it", () => {
    const update = mail({ label_ids: ["INBOX", "CATEGORY_UPDATES"] });
    expect(judgeGmail(update, { address, options: { includeUpdates: true } }).relevant).toBe(true);
  });

  it("always tells of a VIP sender, by address or domain, marked as such", () => {
    const list = withHeaders(
      { "List-Id": "team.x.io" },
      { label_ids: ["INBOX", "CATEGORY_FORUMS"] },
    );
    expect(judgeGmail(list, { address }).relevant).toBe(false);
    expect(judgeGmail(list, { address, options: { vipSenders: ["x.io"] } })).toMatchObject({
      relevant: true,
      event: { facts: { vip: true } },
    });
    expect(judgeGmail(list, { address, options: { vipSenders: ["ana@x.io"] } }).relevant).toBe(
      true,
    );
  });

  it("reads camel-case fields too, and cuts a long body", () => {
    const result = judgeGmail(
      {
        messageId: "m9",
        sender: "ana@x.io",
        to: address,
        labelIds: ["INBOX"],
        messageText: "x".repeat(500),
      },
      { address },
    );
    expect(result).toMatchObject({ relevant: true, event: { id: "gmail:me@example.com:m9" } });
    expect(result.relevant && result.event.excerpt?.length).toBe(301);
  });
});

describe("addressesIn", () => {
  it("finds every address in a header, lower-cased", () => {
    expect(addressesIn('"Lima, Ana" <Ana@X.io>, bo@y.io')).toEqual(["ana@x.io", "bo@y.io"]);
  });
});
