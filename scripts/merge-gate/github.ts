// The GitHub calls behind the collector's GitHub interface, over the global
// fetch so the workflow installs nothing. Auto-merge exists only in GraphQL, so
// its three calls go to <apiUrl>/graphql and the rest go to REST.
//
// GitHub can answer 404 to the update of a check run it created a moment
// earlier, and 5xx or 429 under load. The check run writes, the auto-merge
// mutations and the auto-merge read are tried again on those answers and on
// network errors, so one such answer does not leave the required check in
// progress.

import { type ApiFile, CHECK_NAME, type CheckReport, type GitHub } from "./collect.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Wait = (ms: number) => Promise<void>;

/** The waits between the tries of a retried call: 4 tries in all. */
const RETRY_WAITS_MS = [1000, 2000, 4000];

/** GitHub serves at most 3000 files of a PR, 100 per page. */
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30;

/**
 * A GitHub client that authenticates with `token`. Every non-2xx response
 * throws, except a 404 from readFile. A GraphQL call also throws when the
 * response carries errors. A GraphQL error's message is GitHub's messages
 * joined by "; ", or `HTTP <status>` when there are none.
 *
 * The check run calls and every GraphQL call are tried up to 4 times when the
 * answer is a 5xx, a 429 or a network error, and a check run update also on a
 * 404. `wait` sleeps between tries, and tests pass one that returns at once.
 */
export function restClient(opts: {
  token: string;
  apiUrl: string;
  fetch?: Fetch;
  wait?: Wait;
}): GitHub {
  const doFetch = opts.fetch ?? fetch;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = (accept = "application/vnd.github+json") => ({
    Accept: accept,
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "merge-gate",
  });

  /**
   * Sends one request, and again after each wait while the answer is one
   * `retry` accepts or the request fails on the network. Returns the last answer.
   */
  async function send(
    url: string,
    init: RequestInit,
    retry: ((status: number) => boolean) | undefined,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = !retry || attempt === RETRY_WAITS_MS.length;
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (error) {
        if (last) throw error;
        await wait(RETRY_WAITS_MS[attempt] as number);
        continue;
      }
      if (last || !retry(res.status)) return res;
      await res.body?.cancel().catch(() => {});
      await wait(RETRY_WAITS_MS[attempt] as number);
    }
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    retry?: (status: number) => boolean,
  ): Promise<unknown> {
    const res = await send(
      `${opts.apiUrl}${path}`,
      {
        method,
        headers: { ...headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      retry,
    );
    if (!res.ok) throw await httpError(method, path, res);
    return res.json();
  }

  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await send(
      `${opts.apiUrl}/graphql`,
      {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      transient,
    );
    const body = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      errors?: { message?: string }[];
    } | null;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message ?? "unknown error").join("; "));
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return body?.data;
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
        undefined,
        transient,
      )) as { check_runs: { id: number; app?: { slug?: string } | null }[] };
      // Only a run this workflow's token made is updated. Another app may use the
      // same name, and its run is not ours to overwrite.
      const own = listed.check_runs.find((r) => r.app?.slug === "github-actions");
      const output = { title: report.title, summary: report.summary };
      const body =
        report.conclusion === null
          ? { name: CHECK_NAME, status: "in_progress", output }
          : {
              name: CHECK_NAME,
              status: "completed",
              conclusion: report.conclusion,
              completed_at: new Date().toISOString(),
              output,
            };
      if (own) await call("PATCH", `/repos/${repo}/check-runs/${own.id}`, body, updateRetry);
      else
        await call("POST", `/repos/${repo}/check-runs`, { ...body, head_sha: headSha }, transient);
    },

    async autoMerge(repo, number) {
      const [owner, name] = repo.split("/");
      const data = (await graphql(AUTO_MERGE_QUERY, { owner, name, number })) as {
        repository?: { pullRequest?: { id?: string; autoMergeRequest?: unknown } | null } | null;
      } | null;
      const pr = data?.repository?.pullRequest;
      if (!pr || typeof pr.id !== "string")
        throw new Error(`pull request ${repo}#${number} not found`);
      return { pullRequestId: pr.id, enabled: pr.autoMergeRequest != null };
    },

    async enableAutoMerge(pullRequestId, headSha) {
      await graphql(ENABLE_AUTO_MERGE, {
        pullRequestId,
        mergeMethod: "SQUASH",
        expectedHeadOid: headSha,
      });
    },

    async disableAutoMerge(pullRequestId) {
      await graphql(DISABLE_AUTO_MERGE, { pullRequestId });
    },
  };
}

const AUTO_MERGE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id autoMergeRequest { enabledAt } }
  }
}`;

const ENABLE_AUTO_MERGE = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) {
    clientMutationId
  }
}`;

const DISABLE_AUTO_MERGE = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;

/** An answer that may pass on its own: a server error or a rate limit. */
function transient(status: number): boolean {
  return status >= 500 || status === 429;
}

/** A check run update also retries a 404, which GitHub gives a run it has just created. */
function updateRetry(status: number): boolean {
  return status === 404 || transient(status);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function httpError(method: string, path: string, res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  return new Error(`GitHub ${method} ${path} returned ${res.status}: ${detail}`);
}
