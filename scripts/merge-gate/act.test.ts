import { describe, expect, it } from "@rstest/core";
import { judge } from "./act.js";
import { MERGING_LINE, type PullRequest } from "./collect.js";
import { restClient } from "./github.js";

interface Request {
  method: string;
  url: string;
  body?: { query?: string; variables?: Record<string, unknown>; conclusion?: string };
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
    if (path.startsWith("/repos/o/rome/commits/head1/check-runs")) return json({ check_runs: [] });
    if (path === "/repos/o/rome/check-runs" && method === "POST") return json({ id: 1 }, 201);
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

async function run(api: Api, enabled: boolean) {
  const f = fakeApi(api);
  const gh = restClient({ token: "t", apiUrl: "https://api.test", fetch: f.fetch });
  const report = await judge(gh, pr, policy(enabled));
  const step = (r: Request) => {
    const q = r.body?.query ?? "";
    if (q.includes("enablePullRequestAutoMerge")) return "enable";
    if (q.includes("disablePullRequestAutoMerge")) return "disable";
    if (r.url.endsWith("/graphql")) return "read auto-merge";
    if (r.method === "POST" && r.url.endsWith("/check-runs"))
      return `check run ${r.body?.conclusion}`;
    return `${r.method} ${r.url.replace("https://api.test", "").split("?")[0]}`;
  };
  return { report, requests: f.requests, steps: f.requests.map(step) };
}

const AUTO_MERGE_ON = { enabledAt: "2026-11-20T00:00:00Z" };

describe("judge, by decision", () => {
  it("merge: turns auto-merge on bound to the head, then writes a success check run", async () => {
    const { report, requests, steps } = await run({ files: [listed] }, true);
    expect(steps).toEqual([
      "GET /repos/o/rome/pulls/7/files",
      "read auto-merge",
      "enable",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run success",
    ]);
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

  it("merge: turns auto-merge on even when an earlier commit turned it on", async () => {
    const { steps } = await run({ files: [listed], autoMergeRequest: AUTO_MERGE_ON }, true);
    expect(steps.filter((s) => s === "enable")).toHaveLength(1);
    expect(steps).not.toContain("disable");
  });

  it("report-only: makes only reads and the check run write", async () => {
    const { report, requests } = await run({ files: [listed] }, false);
    const writes = requests.filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/repos/o/rome/check-runs",
      body: { conclusion: "success" },
    });
    expect(requests.some((r) => r.url.endsWith("/graphql"))).toBe(false);
    expect(report.title).toBe("would merge itself");
  });

  it.each([
    true,
    false,
  ])("none, enabled %s: turns auto-merge off before a neutral check run", async (enabled) => {
    const { report, steps } = await run(
      { files: [unlisted], autoMergeRequest: AUTO_MERGE_ON },
      enabled,
    );
    expect(steps).toEqual([
      "GET /repos/o/rome/pulls/7/files",
      "read auto-merge",
      "disable",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run neutral",
    ]);
    expect(report.title).toBe("needs you: 1 reason");
  });

  it("none: leaves auto-merge alone when it is off", async () => {
    const { steps } = await run({ files: [unlisted] }, true);
    expect(steps).toEqual([
      "GET /repos/o/rome/pulls/7/files",
      "read auto-merge",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run neutral",
    ]);
  });

  it("error: turns auto-merge off before a neutral check run, like none", async () => {
    const { report, steps } = await run({ files: 502, autoMergeRequest: AUTO_MERGE_ON }, true);
    expect(steps).toEqual([
      "GET /repos/o/rome/pulls/7/files",
      "read auto-merge",
      "disable",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run neutral",
    ]);
    expect(report.title).toBe("needs you: the gate could not decide");
  });
});

describe("judge, when auto-merge cannot be changed", () => {
  it("writes a neutral run with the API's message when auto-merge cannot be turned on", async () => {
    const enable = { errors: [{ message: "Auto merge is not allowed for this repository" }] };
    const { report, steps } = await run({ files: [listed], enable }, true);
    expect(steps).toEqual([
      "GET /repos/o/rome/pulls/7/files",
      "read auto-merge",
      "enable",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run neutral",
    ]);
    expect(report.title).toBe("qualifies, but auto-merge could not be turned on");
    expect(report.summary.split("\n")[0]).toBe("**Merge gate: qualifies.**");
    expect(report.summary).toContain(
      "Auto-merge could not be turned on: Auto merge is not allowed for this repository.",
    );
  });

  it("writes a neutral run when the enable call returns an HTTP error", async () => {
    const { report } = await run({ files: [listed], enable: 502 }, true);
    expect(report.conclusion).toBe("neutral");
    expect(report.summary).toMatch(/Auto-merge could not be turned on: .*502/);
  });

  it("writes a failure run when auto-merge cannot be turned off", async () => {
    const disable = { errors: [{ message: "Something went wrong." }] };
    const { report, steps } = await run(
      { files: [unlisted], autoMergeRequest: AUTO_MERGE_ON, disable },
      true,
    );
    expect(steps.slice(-3)).toEqual([
      "disable",
      "GET /repos/o/rome/commits/head1/check-runs",
      "check run failure",
    ]);
    expect(report.title).toBe("needs you: auto-merge could not be turned off");
    expect(report.summary).toContain("Auto-merge could not be turned off: Something went wrong.");
  });

  it("writes a failure run when whether auto-merge is on cannot be read", async () => {
    const { report, steps } = await run({ files: [unlisted], stateStatus: 502 }, true);
    expect(steps).not.toContain("disable");
    expect(report.conclusion).toBe("failure");
    expect(report.title).toBe("needs you: auto-merge could not be turned off");
  });
});
