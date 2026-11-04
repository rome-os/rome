import { describe, expect, it } from "@rstest/core";
import { githubAlertOf, githubLoginReader } from "./github-alerts.js";

const repository = { full_name: "acme/widgets" };
const me = "Octo-Me";

describe("githubAlertOf", () => {
  it("alerts on a review requested of the guardian, not of someone else", () => {
    const payload = {
      action: "review_requested",
      repository,
      sender: { login: "alice" },
      requested_reviewer: { login: "octo-me" },
      pull_request: {
        number: 7,
        title: "Fix it",
        html_url: "https://github.com/acme/widgets/pull/7",
        user: { login: "alice" },
      },
    };
    expect(githubAlertOf("pull_request", payload, me)).toEqual({
      id: "github:acme/widgets:pr:7:review_requested",
      source: "github",
      kind: "review_requested",
      fields: {
        repo: "acme/widgets",
        number: "7",
        title: "Fix it",
        url: "https://github.com/acme/widgets/pull/7",
        author: "alice",
        actor: "alice",
      },
    });
    const other = { ...payload, requested_reviewer: { login: "bob" } };
    expect(githubAlertOf("pull_request", other, me)).toBeNull();
  });

  it("alerts on a comment on the guardian's PR, or one that mentions them, but never their own", () => {
    const comment = (body: string, author = "alice", issueUser = "octo-me") => ({
      action: "created",
      repository,
      sender: { login: author },
      issue: { number: 3, title: "Bug", user: { login: issueUser }, pull_request: {} },
      comment: { id: 99, body, html_url: "https://github.com/acme/widgets/pull/3#c99" },
    });
    expect(githubAlertOf("issue_comment", comment("lgtm?"), me)?.kind).toBe("comment_on_your_pr");
    expect(githubAlertOf("issue_comment", comment("ping @octo-me", "alice", "bob"), me)?.kind).toBe(
      "mention",
    );
    expect(
      githubAlertOf("issue_comment", comment("ping @octo-meow", "alice", "bob"), me),
    ).toBeNull();
    expect(githubAlertOf("issue_comment", comment("note to self", "octo-me"), me)).toBeNull();
  });

  it("marks a bot's comment and cuts long text", () => {
    const payload = {
      action: "created",
      repository,
      sender: { login: "codecov[bot]", type: "Bot" },
      issue: { number: 3, user: { login: "octo-me" } },
      comment: { id: 1, body: "x".repeat(500) },
    };
    const alert = githubAlertOf("issue_comment", payload, me);
    expect(alert?.fields.actor_type).toBe("bot");
    expect(alert?.kind).toBe("comment_on_your_issue");
    expect(alert?.text?.length).toBe(301);
  });

  it("alerts on a failed run the guardian triggered, even though they sent it", () => {
    const payload = {
      action: "completed",
      repository,
      sender: { login: "octo-me" },
      workflow_run: {
        id: 5,
        run_attempt: 2,
        name: "CI",
        conclusion: "failure",
        head_branch: "fix",
        html_url: "https://github.com/acme/widgets/actions/runs/5",
        actor: { login: "octo-me" },
        triggering_actor: { login: "octo-me" },
        pull_requests: [{ number: 7 }],
      },
    };
    const alert = githubAlertOf("workflow_run", payload, me);
    expect(alert?.id).toBe("github:acme/widgets:run:5:2");
    expect(alert?.fields.pr).toBe("7");
    const someoneElses = {
      ...payload,
      sender: { login: "bob" },
      workflow_run: {
        ...payload.workflow_run,
        actor: { login: "bob" },
        triggering_actor: { login: "bob" },
      },
    };
    expect(githubAlertOf("workflow_run", someoneElses, me)).toBeNull();
    const passed = { ...payload, workflow_run: { ...payload.workflow_run, conclusion: "success" } };
    expect(githubAlertOf("workflow_run", passed, me)).toBeNull();
  });

  it("alerts on a review of the guardian's PR", () => {
    const payload = {
      action: "submitted",
      repository,
      sender: { login: "alice" },
      pull_request: { number: 7, user: { login: "octo-me" } },
      review: { id: 11, state: "CHANGES_REQUESTED", body: "Please split this" },
    };
    const alert = githubAlertOf("pull_request_review", payload, me);
    expect(alert?.fields.state).toBe("changes_requested");
    expect(alert?.text).toBe("Please split this");
  });
});

describe("githubLoginReader", () => {
  it("reads the login once per token, and null without one", async () => {
    let token: string | null = "t1";
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ login: "octo-me" }), { status: 200 });
    }) as unknown as typeof fetch;
    const read = githubLoginReader(async () => token, fakeFetch);
    expect(await read()).toBe("octo-me");
    expect(await read()).toBe("octo-me");
    expect(calls).toBe(1);
    token = null;
    expect(await read()).toBeNull();
  });
});
