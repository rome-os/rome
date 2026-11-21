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

const client = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  restClient({ token: "t", apiUrl: "https://api.test", fetch });

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
