import { describe, expect, it } from "@rstest/core";
import { judge } from "./act.js";
import { MERGING_LINE, type PullRequest } from "./collect.js";
import { restClient } from "./github.js";

interface Request {
  method: string;
  url: string;
  body?: {
    query?: string;
    variables?: Record<string, unknown>;
    status?: string;
    conclusion?: string;
    output?: { title?: string };
  };
}

/** What the fake API answers. Each GraphQL answer is the response body, or an HTTP status. */
interface Api {
  files?: unknown[] | number;
  /** null: no auto-merge request on the PR. */
  autoMergeRequest?: unknown;
  stateStatus?: number;
  enable?: unknown;
  disable?: unknown;
}

/** A fake GitHub API over an injected fetch that records every request in order. */
function fakeApi(api: Api) {
  const requests: Request[] = [];
  /** Ids of the check runs this workflow has created on head1. */
  const runs: number[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, ...(body ? { body } : {}) });
    const path = url.replace("https://api.test", "");
    if (path.startsWith("/repos/o/rome/pulls/7/files")) {
      const files = api.files ?? [];
      return typeof files === "number" ? json({ message: "boom" }, files) : json(files);
    }
    if (path.startsWith("/repos/o/rome/commits/head1/check-runs")) {
      return json({ check_runs: runs.map((id) => ({ id, app: { slug: "github-actions" } })) });
    }
    if (path === "/repos/o/rome/check-runs" && method === "POST") {
      runs.push(runs.length + 1);
      return json({ id: runs.length }, 201);
    }
    if (/^\/repos\/o\/rome\/check-runs\/\d+$/.test(path) && method === "PATCH") return json({});
    if (path === "/graphql") {
      const query = String(body.query);
      if (query.includes("enablePullRequestAutoMerge")) return answer(api.enable);
      if (query.includes("disablePullRequestAutoMerge")) return answer(api.disable);
      if (api.stateStatus) return json({ message: "boom" }, api.stateStatus);
      return json({
        data: {
          repository: {
            pullRequest: { id: "PR_7", autoMergeRequest: api.autoMergeRequest ?? null },
          },
        },
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const answer = (a: unknown) =>
    typeof a === "number" ? json({ message: "boom" }, a) : json(a ?? { data: {} });
  return { fetch, requests };
}

const pr: PullRequest = {
  repo: "o/rome",
  number: 7,
  author: "zhangfand",
  fromFork: false,
  baseSha: "base1",
  headSha: "head1",
};

const policy = (enabled: boolean) => () =>
  JSON.stringify({
    enabled,
    author: "zhangfand",
    maxChangedLines: 400,
    selfMerge: [{ paths: ["packages/core/src/participation/**"], reason: "Pinned." }],
  });

const listed = {
  filename: "packages/core/src/participation/addressing.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1,2 @@\n line\n+more",
};
const unlisted = { ...listed, filename: "packages/core/src/index.ts" };

const noWait = async () => {};

async function run(api: Api, enabled: boolean) {
  const f = fakeApi(api);
  const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: f.fetch, wait: noWait });
  const report = await judge(gh, pr, policy(enabled));
  const step = (r: Request) => {
    const q = r.body?.query ?? "";
    if (q.includes("enablePullRequestAutoMerge")) return "enable";
    if (q.includes("disablePullRequestAutoMerge")) return "disable";
    if (r.url.endsWith("/graphql")) return "read auto-merge";
    if (r.method === "POST" || r.method === "PATCH") {
      const verb = r.method === "POST" ? "create" : "update";
      return `${verb} check run ${r.body?.conclusion ?? r.body?.status}`;
    }
    return `${r.method} ${r.url.replace("https://api.test", "").split("?")[0]}`;
  };
  return { report, requests: f.requests, steps: f.requests.map(step) };
}

const AUTO_MERGE_ON = { enabledAt: "2026-11-20T00:00:00Z" };

const LIST = "GET /repos/o/rome/commits/head1/check-runs";
const FILES = "GET /repos/o/rome/pulls/7/files";

describe("judge, by decision", () => {
  it("merge: marks the run in progress, turns auto-merge on bound to the head, then succeeds", async () => {
    const { report, requests, steps } = await run({ files: [listed] }, true);
    expect(steps).toEqual([
      FILES,
      "read auto-merge",
      LIST,
      "create check run in_progress",
      "enable",
      LIST,
      "update check run success",
    ]);
    const pending = requests.find((r) => r.body?.status === "in_progress");
    expect(pending?.body).not.toHaveProperty("conclusion");
    expect(pending?.body?.output?.title).toBe("deciding");
    const enables = requests.filter((r) => r.body?.query?.includes("enablePullRequestAutoMerge"));
    expect(enables).toHaveLength(1);
    expect(enables[0]?.url).toBe("https://api.test/graphql");
    expect(enables[0]?.body?.variables).toEqual({
      pullRequestId: "PR_7",
      mergeMethod: "SQUASH",
      expectedHeadOid: "head1",
    });
    expect(report.title).toBe("qualifies");
    expect(report.summary.split("\n").slice(0, 3)).toEqual([
      "**Merge gate: qualifies.**",
      "",
      MERGING_LINE,
    ]);
  });

  it("merge: makes no enable call when auto-merge is already on", async () => {
    const { report, steps } = await run({ files: [listed], autoMergeRequest: AUTO_MERGE_ON }, true);
    expect(steps).toEqual([
      FILES,
      "read auto-merge",
      LIST,
      "create check run in_progress",
      LIST,
      "update check run success",
    ]);
    expect(report.summary.split("\n")[2]).toBe(MERGING_LINE);
  });

  it("report-only: makes only reads and the check run write", async () => {
    const { report, requests } = await run({ files: [listed] }, false);
    const writes = requests.filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/repos/o/rome/check-runs",
      body: { status: "completed", conclusion: "success" },
    });
    expect(requests.some((r) => r.url.endsWith("/graphql"))).toBe(false);
    expect(report.title).toBe("would merge itself");
  });

  it("none: turns auto-merge off before a neutral check run", async () => {
    const { report, steps } = await run(
      { files: [unlisted], autoMergeRequest: AUTO_MERGE_ON },
      true,
    );
    expect(steps).toEqual([FILES, "read auto-merge", "disable", LIST, "create check run neutral"]);
    expect(report.title).toBe("needs you: 1 reason");
  });

  it("none: leaves auto-merge alone when it is off", async () => {
    const { steps } = await run({ files: [unlisted] }, true);
    expect(steps).toEqual([FILES, "read auto-merge", LIST, "create check run neutral"]);
  });

  it("error: turns auto-merge off before a neutral check run, like none", async () => {
    const { report, steps } = await run({ files: 502, autoMergeRequest: AUTO_MERGE_ON }, true);
    expect(steps).toEqual([FILES, "read auto-merge", "disable", LIST, "create check run neutral"]);
    expect(report.title).toBe("needs you: the gate could not decide");
  });

  it("error, policy unreadable: acts as if enabled and turns auto-merge off", async () => {
    const f = fakeApi({ files: [listed], autoMergeRequest: AUTO_MERGE_ON });
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: f.fetch });
    const report = await judge(gh, pr, () => "{");
    expect(
      f.requests.filter((r) => r.body?.query?.includes("disablePullRequestAutoMerge")),
    ).toHaveLength(1);
    expect(report.title).toBe("needs you: the gate could not decide");
  });
});

describe("judge, with the policy's enabled false", () => {
  it.each([
    ["none", { files: [unlisted] }, "needs you: 1 reason"],
    ["error", { files: 502 }, "needs you: the gate could not decide"],
    ["report-only", { files: [listed] }, "would merge itself"],
  ] as const)("%s: never reads or changes auto-merge, even when it is on", async (_, api, title) => {
    const { report, requests, steps } = await run(
      { ...api, autoMergeRequest: AUTO_MERGE_ON },
      false,
    );
    expect(requests.some((r) => r.url.endsWith("/graphql"))).toBe(false);
    expect(steps.slice(-2)).toEqual([LIST, `create check run ${report.conclusion}`]);
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(1);
    expect(report.title).toBe(title);
  });

  it("error, policy malformed but enabled false: still hands off", async () => {
    const f = fakeApi({ files: [listed], autoMergeRequest: AUTO_MERGE_ON });
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: f.fetch });
    const report = await judge(gh, pr, () => JSON.stringify({ enabled: false }));
    expect(f.requests.some((r) => r.url.endsWith("/graphql"))).toBe(false);
    expect(report.title).toBe("needs you: the gate could not decide");
  });
});

describe("judge, when auto-merge cannot be changed", () => {
  it("writes a neutral run with the API's messages when auto-merge cannot be turned on", async () => {
    const enable = {
      errors: [
        { message: "Auto merge is not allowed for this repository." },
        { message: "Try later" },
      ],
    };
    const { report, steps } = await run({ files: [listed], enable }, true);
    expect(steps).toEqual([
      FILES,
      "read auto-merge",
      LIST,
      "create check run in_progress",
      "enable",
      LIST,
      "update check run neutral",
    ]);
    expect(report.title).toBe("qualifies, but auto-merge could not be turned on");
    expect(report.summary.split("\n").slice(0, 6)).toEqual([
      "**Merge gate: qualifies.**",
      "",
      "Every changed path is listed in the merge policy, so this PR merges itself.",
      "",
      "Auto-merge could not be turned on: Auto merge is not allowed for this repository.; Try later.",
      "",
    ]);
    expect(report.summary.split("\n")[6]).toMatch(/^- `/);
  });

  it("names the HTTP status when the enable call fails without GraphQL errors", async () => {
    const { report, steps } = await run({ files: [listed], enable: 502 }, true);
    expect(steps.filter((s) => s === "enable")).toHaveLength(4);
    expect(report.conclusion).toBe("neutral");
    expect(report.summary).toContain("Auto-merge could not be turned on: HTTP 502.");
  });

  it("merge: counts a failed read of auto-merge as a failed enable, with no enable call", async () => {
    const { report, steps } = await run({ files: [listed], stateStatus: 403 }, true);
    expect(steps).toEqual([FILES, "read auto-merge", LIST, "create check run neutral"]);
    expect(report.title).toBe("qualifies, but auto-merge could not be turned on");
    expect(report.summary).toContain("Auto-merge could not be turned on: HTTP 403.");
  });

  it("writes a failure run when auto-merge cannot be turned off", async () => {
    const disable = { errors: [{ message: "Something went wrong." }] };
    const { report, steps } = await run(
      { files: [unlisted], autoMergeRequest: AUTO_MERGE_ON, disable },
      true,
    );
    expect(steps.slice(-3)).toEqual(["disable", LIST, "create check run failure"]);
    expect(report.title).toBe("needs you: auto-merge could not be turned off");
    expect(report.summary.split("\n").slice(3, 6)).toEqual([
      "",
      "Auto-merge could not be turned off: Something went wrong.",
      "",
    ]);
  });

  it("needs you: counts a failed read of auto-merge as a failed disable", async () => {
    const { report, steps } = await run({ files: [unlisted], stateStatus: 502 }, true);
    expect(steps).not.toContain("disable");
    expect(report.conclusion).toBe("failure");
    expect(report.title).toBe("needs you: auto-merge could not be turned off");
    expect(report.summary).toContain("Auto-merge could not be turned off: HTTP 502.");
  });

  it("makes no enable call when the in-progress check run cannot be written", async () => {
    const f = fakeApi({ files: [listed] });
    const failing = async (url: string, init?: RequestInit) =>
      url.endsWith("/check-runs") && init?.method === "POST"
        ? new Response("{}", { status: 500 })
        : f.fetch(url, init);
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: failing, wait: noWait });
    await expect(judge(gh, pr, policy(true))).rejects.toThrow("500");
    expect(f.requests.some((r) => r.body?.query?.includes("enablePullRequestAutoMerge"))).toBe(
      false,
    );
  });

  it("merge: completes the run after a 404 on its update, with one enable call", async () => {
    const f = fakeApi({ files: [listed] });
    let patches = 0;
    const flaky = async (url: string, init?: RequestInit) =>
      init?.method === "PATCH" && ++patches === 1
        ? (f.requests.push({ method: "PATCH", url }), new Response("{}", { status: 404 }))
        : f.fetch(url, init);
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: flaky, wait: noWait });
    const report = await judge(gh, pr, policy(true));
    expect(report.conclusion).toBe("success");
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
    expect(
      f.requests.filter((r) => r.body?.query?.includes("enablePullRequestAutoMerge")),
    ).toHaveLength(1);
  });

  it("merge: turns auto-merge off again, then throws, when the last write keeps failing", async () => {
    const f = fakeApi({ files: [listed] });
    const failing = async (url: string, init?: RequestInit) => {
      if (init?.method !== "PATCH") return f.fetch(url, init);
      f.requests.push({ method: "PATCH", url });
      return new Response("{}", { status: 404 });
    };
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: failing, wait: noWait });
    await expect(judge(gh, pr, policy(true))).rejects.toThrow("404");
    const steps = f.requests.map((r) => {
      const q = r.body?.query ?? "";
      if (q.includes("enablePullRequestAutoMerge")) return "enable";
      if (q.includes("disablePullRequestAutoMerge")) return "disable";
      return r.method;
    });
    expect(steps.slice(-7)).toEqual([
      "enable",
      "GET",
      "PATCH",
      "PATCH",
      "PATCH",
      "PATCH",
      "disable",
    ]);
  });

  it("needs you: throws without an extra call when the last write keeps failing", async () => {
    const f = fakeApi({ files: [unlisted] });
    const failing = async (url: string, init?: RequestInit) =>
      url.endsWith("/check-runs") && init?.method === "POST"
        ? (f.requests.push({ method: "POST", url }), new Response("{}", { status: 503 }))
        : f.fetch(url, init);
    const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: failing, wait: noWait });
    await expect(judge(gh, pr, policy(true))).rejects.toThrow("503");
    expect(
      f.requests.filter((r) => r.method === "POST" && !r.url.endsWith("/graphql")),
    ).toHaveLength(4);
    expect(f.requests.at(-1)?.method).toBe("POST");
    expect(f.requests.at(-1)?.url).toBe("https://api.test/repos/o/rome/check-runs");
  });
});
