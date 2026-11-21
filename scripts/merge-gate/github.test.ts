import { describe, expect, it } from "@rstest/core";
import { restClient } from "./github.js";

interface Call {
  method: string;
  url: string;
  accept: string;
  body?: unknown;
}

/** A fake fetch that answers each call with the next queued response and records the call. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url,
      accept: headers.Accept ?? "",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return next;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Records each wait instead of sleeping. */
const waits: number[] = [];
const client = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  restClient({
    token: "t",
    apiUrl: "https://api.test",
    fetch,
    wait: async (ms) => {
      waits.push(ms);
    },
  });

const report = { title: "would merge itself", summary: "s", conclusion: "success" as const };

describe("restClient.listFiles", () => {
  it("reads every page until a short one", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}` }));
    const f = fakeFetch([json(page(100)), json(page(3))]);
    const files = await client(f.fetch).listFiles("o/r", 7);
    expect(files).toHaveLength(103);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.test/repos/o/r/pulls/7/files?per_page=100&page=1",
      "https://api.test/repos/o/r/pulls/7/files?per_page=100&page=2",
    ]);
  });

  it("throws on an API error", async () => {
    const f = fakeFetch([json({ message: "boom" }, 502)]);
    await expect(client(f.fetch).listFiles("o/r", 7)).rejects.toThrow("502");
  });
});

describe("restClient.readFile", () => {
  it("reads the raw text at a ref", async () => {
    const f = fakeFetch([new Response('{"x": 1}')]);
    expect(await client(f.fetch).readFile("o/r", "goals/a b/baseline.json", "abc")).toBe(
      '{"x": 1}',
    );
    expect(f.calls[0]).toMatchObject({
      url: "https://api.test/repos/o/r/contents/goals/a%20b/baseline.json?ref=abc",
      accept: "application/vnd.github.raw+json",
    });
  });

  it("returns undefined for a missing file", async () => {
    const f = fakeFetch([json({ message: "Not Found" }, 404)]);
    expect(await client(f.fetch).readFile("o/r", "x", "abc")).toBeUndefined();
  });
});

describe("restClient.putCheckRun", () => {
  it("creates the check run on the head commit when none exists", async () => {
    const f = fakeFetch([json({ check_runs: [] }), json({ id: 1 }, 201)]);
    await client(f.fetch).putCheckRun("o/r", "sha1", report);
    expect(f.calls[0]?.url).toBe(
      "https://api.test/repos/o/r/commits/sha1/check-runs?check_name=merge%20gate&per_page=100",
    );
    expect(f.calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.test/repos/o/r/check-runs",
      body: {
        name: "merge gate",
        head_sha: "sha1",
        status: "completed",
        conclusion: "success",
        output: { title: "would merge itself", summary: "s" },
      },
    });
  });

  it("updates the run this workflow made before, and leaves another app's alone", async () => {
    const runs = [
      { id: 5, app: { slug: "someone-else" } },
      { id: 9, app: { slug: "github-actions" } },
    ];
    const f = fakeFetch([json({ check_runs: runs }), json({ id: 9 })]);
    await client(f.fetch).putCheckRun("o/r", "sha1", report);
    expect(f.calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.test/repos/o/r/check-runs/9",
    });
    expect(f.calls[1]?.body).not.toHaveProperty("head_sha");
  });
});

describe("restClient.putCheckRun, in progress", () => {
  it("writes an in-progress run with no conclusion when the report has none", async () => {
    const f = fakeFetch([json({ check_runs: [] }), json({ id: 1 }, 201)]);
    await client(f.fetch).putCheckRun("o/r", "sha1", {
      title: "deciding",
      summary: "s",
      conclusion: null,
    });
    expect(f.calls[1]?.body).toEqual({
      name: "merge gate",
      head_sha: "sha1",
      status: "in_progress",
      output: { title: "deciding", summary: "s" },
    });
  });
});

describe("restClient auto-merge", () => {
  it("names the HTTP status when GraphQL fails without errors", async () => {
    const f = fakeFetch([json({ message: "Forbidden" }, 403)]);
    await expect(client(f.fetch).disableAutoMerge("PR_7")).rejects.toThrow(/^HTTP 403$/);
  });

  it("joins GitHub's messages with a semicolon, also on a non-2xx response", async () => {
    const f = fakeFetch([json({ errors: [{ message: "a" }, { message: "b" }] }, 403)]);
    await expect(client(f.fetch).enableAutoMerge("PR_7", "sha1")).rejects.toThrow(/^a; b$/);
  });

  it("reads the PR's node id and whether auto-merge is on from GraphQL", async () => {
    const pr = { id: "PR_7", autoMergeRequest: { enabledAt: "2026-11-20T00:00:00Z" } };
    const f = fakeFetch([json({ data: { repository: { pullRequest: pr } } })]);
    expect(await client(f.fetch).autoMerge("o/r", 7)).toEqual({
      pullRequestId: "PR_7",
      enabled: true,
    });
    expect(f.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/graphql",
      body: { variables: { owner: "o", name: "r", number: 7 } },
    });
  });

  it("reads auto-merge as off when the PR has no auto-merge request", async () => {
    const pr = { id: "PR_7", autoMergeRequest: null };
    const f = fakeFetch([json({ data: { repository: { pullRequest: pr } } })]);
    expect((await client(f.fetch).autoMerge("o/r", 7)).enabled).toBe(false);
  });

  it("throws GitHub's messages when GraphQL answers with errors", async () => {
    const f = fakeFetch([json({ data: null, errors: [{ message: "Head sha didn't match" }] })]);
    await expect(client(f.fetch).enableAutoMerge("PR_7", "sha1")).rejects.toThrow(
      "Head sha didn't match",
    );
  });

  it("turns auto-merge off by the PR's node id", async () => {
    const f = fakeFetch([json({ data: { disablePullRequestAutoMerge: {} } })]);
    await client(f.fetch).disableAutoMerge("PR_7");
    expect(f.calls[0]?.body).toMatchObject({ variables: { pullRequestId: "PR_7" } });
    expect(String((f.calls[0]?.body as { query: string }).query)).toContain(
      "disablePullRequestAutoMerge",
    );
  });
});

describe("restClient retries", () => {
  const checkRuns = (id: number) => json({ check_runs: [{ id, app: { slug: "github-actions" } }] });

  it("updates a check run again after a 404, waiting about a second", async () => {
    waits.length = 0;
    const f = fakeFetch([checkRuns(9), json({ message: "Not Found" }, 404), json({ id: 9 })]);
    await client(f.fetch).putCheckRun("o/r", "sha1", report);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "PATCH"]);
    expect(f.calls[2]?.url).toBe("https://api.test/repos/o/r/check-runs/9");
    expect(waits).toEqual([1000]);
  });

  it("gives up after four tries in a row, with waits of 1, 2 and 4 seconds", async () => {
    waits.length = 0;
    const f = fakeFetch([
      checkRuns(9),
      json({ message: "Not Found" }, 404),
      json({ message: "boom" }, 502),
      json({ message: "slow down" }, 429),
      json({ message: "Not Found" }, 404),
    ]);
    await expect(client(f.fetch).putCheckRun("o/r", "sha1", report)).rejects.toThrow("404");
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "PATCH", "PATCH", "PATCH"]);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry a 422", async () => {
    waits.length = 0;
    const f = fakeFetch([checkRuns(9), json({ message: "Unprocessable" }, 422)]);
    await expect(client(f.fetch).putCheckRun("o/r", "sha1", report)).rejects.toThrow("422");
    expect(f.calls).toHaveLength(2);
    expect(waits).toEqual([]);
  });

  it("does not retry a 404 on a check run create", async () => {
    const f = fakeFetch([json({ check_runs: [] }), json({ message: "Not Found" }, 404)]);
    await expect(client(f.fetch).putCheckRun("o/r", "sha1", report)).rejects.toThrow("404");
    expect(f.calls).toHaveLength(2);
  });

  it("retries a network error on a check run create", async () => {
    let failed = false;
    const f = fakeFetch([json({ check_runs: [] }), json({ id: 1 }, 201)]);
    const flaky = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && !failed) {
        failed = true;
        throw new TypeError("fetch failed");
      }
      return f.fetch(url, init);
    };
    await client(flaky).putCheckRun("o/r", "sha1", report);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("retries a GraphQL mutation on a 5xx and returns the later answer", async () => {
    const f = fakeFetch([json({}, 503), json({ data: { enablePullRequestAutoMerge: {} } })]);
    await client(f.fetch).enableAutoMerge("PR_7", "sha1");
    expect(f.calls).toHaveLength(2);
  });

  it("does not retry GraphQL errors, nor a 404 outside a check run update", async () => {
    const errors = fakeFetch([json({ errors: [{ message: "nope" }] })]);
    await expect(client(errors.fetch).enableAutoMerge("PR_7", "sha1")).rejects.toThrow("nope");
    expect(errors.calls).toHaveLength(1);
    const missing = fakeFetch([json({}, 404)]);
    await expect(client(missing.fetch).autoMerge("o/r", 7)).rejects.toThrow("HTTP 404");
    expect(missing.calls).toHaveLength(1);
  });

  it("names the last answer's status when GraphQL keeps failing", async () => {
    const f = fakeFetch([json({}, 502), json({}, 502), json({}, 502), json({}, 504)]);
    await expect(client(f.fetch).disableAutoMerge("PR_7")).rejects.toThrow(/^HTTP 504$/);
    expect(f.calls).toHaveLength(4);
  });
});
