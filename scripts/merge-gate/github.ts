// The GitHub REST calls behind the collector's GitHub interface, over the
// global fetch so the workflow installs nothing.

import { type ApiFile, CHECK_NAME, type CheckReport, type GitHub } from "./collect.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** GitHub serves at most 3000 files of a PR, 100 per page. */
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30;

/** A GitHub client that authenticates with `token`. Every non-2xx response throws, except a 404 from readFile. */
export function restClient(opts: { token: string; apiUrl: string; fetch?: Fetch }): GitHub {
  const doFetch = opts.fetch ?? fetch;
  const headers = (accept = "application/vnd.github+json") => ({
    Accept: accept,
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "merge-gate",
  });

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${opts.apiUrl}${path}`, {
      method,
      headers: { ...headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw await httpError(method, path, res);
    return res.json();
  }

  return {
    async listFiles(repo, number) {
      const files: ApiFile[] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const batch = (await call(
          "GET",
          `/repos/${repo}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        )) as ApiFile[];
        files.push(...batch);
        if (batch.length < FILES_PER_PAGE) break;
      }
      return files;
    },

    async readFile(repo, path, ref) {
      const url = `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
      const res = await doFetch(`${opts.apiUrl}${url}`, {
        headers: headers("application/vnd.github.raw+json"),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw await httpError("GET", url, res);
      return res.text();
    },

    async putCheckRun(repo, headSha, report) {
      const listed = (await call(
        "GET",
        `/repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
      )) as { check_runs: { id: number; app?: { slug?: string } | null }[] };
      // Only a run this workflow's token made is updated. Another app may use the
      // same name, and its run is not ours to overwrite.
      const own = listed.check_runs.find((r) => r.app?.slug === "github-actions");
      const body = {
        name: CHECK_NAME,
        status: "completed",
        conclusion: report.conclusion,
        completed_at: new Date().toISOString(),
        output: { title: report.title, summary: report.summary },
      };
      if (own) await call("PATCH", `/repos/${repo}/check-runs/${own.id}`, body);
      else await call("POST", `/repos/${repo}/check-runs`, { ...body, head_sha: headSha });
    },
  };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function httpError(method: string, path: string, res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  return new Error(`GitHub ${method} ${path} returned ${res.status}: ${detail}`);
}
