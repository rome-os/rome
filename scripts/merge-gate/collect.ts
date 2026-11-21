// Builds the merge gate's input for one pull request from the GitHub API,
// decides it, and turns the decision into the `merge gate` check run. The
// workflow is .github/workflows/merge-gate.yml and its entry point is run.ts.
//
// The PR reaches the gate only as data: its changed files with their patches,
// and the text of a changed goal baseline. Nothing from the PR's head is
// checked out, imported or run.

import { BASELINE, type ChangedFile, type Decision, decide } from "./gate.js";
import { parseInput } from "./input.js";

export const CHECK_NAME = "merge gate";

/** GitHub caps a check run's summary at 65535 characters. */
const SUMMARY_LIMIT = 65_535;

/** The facts about one PR that the collector reads from the event payload. */
export interface PullRequest {
  /** `owner/name` of the base repository, where the check run goes. */
  repo: string;
  number: number;
  author: string;
  fromFork: boolean;
  baseSha: string;
  headSha: string;
}

/** One entry of `GET /repos/{repo}/pulls/{number}/files`. */
export interface ApiFile {
  filename: string;
  status: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
  /** Absent for a binary file and for a diff GitHub finds too large to show. */
  patch?: string;
}

export interface CheckReport {
  title: string;
  summary: string;
  conclusion: "success" | "neutral";
}

/** The GitHub calls the collector makes, so tests can fake them. */
export interface GitHub {
  /** Every changed file of the PR, across all pages. */
  listFiles(repo: string, number: number): Promise<ApiFile[]>;
  /** The file's text at `ref`, or undefined when no file exists there. */
  readFile(repo: string, path: string, ref: string): Promise<string | undefined>;
  /** Creates the check run on `headSha`, or updates the one this workflow made there before. */
  putCheckRun(repo: string, headSha: string, report: CheckReport): Promise<void>;
}

/** Reads a `pull_request_target` event payload. Throws when a needed field is missing. */
export function pullRequestFrom(event: unknown): PullRequest {
  const pr = field(event, "pull_request");
  const base = field(pr, "base");
  const head = field(pr, "head");
  const baseRepo = text(field(base, "repo"), "full_name");
  // A fork whose repository was deleted has a null head repo. It still came
  // from outside, so it counts as a fork.
  const headRepoRaw = (head as Record<string, unknown>).repo;
  const headRepo = headRepoRaw ? text(headRepoRaw, "full_name") : null;
  const number = (pr as Record<string, unknown>).number;
  if (typeof number !== "number") throw new Error("event.pull_request.number is missing");
  return {
    repo: baseRepo,
    number,
    author: text(field(pr, "user"), "login"),
    fromFork: headRepo !== baseRepo,
    baseSha: text(base, "sha"),
    headSha: text(head, "sha"),
  };
}

/**
 * Maps one API file to the gate's shape. GitHub's `copied` becomes `added`,
 * since the copy's source is unchanged, and `changed` (a mode change) and
 * `unchanged` become `modified`.
 */
export function changedFile(api: ApiFile): ChangedFile {
  const status =
    api.status === "copied"
      ? "added"
      : api.status === "changed" || api.status === "unchanged"
        ? "modified"
        : api.status;
  const file = {
    path: api.filename,
    status,
    additions: api.additions,
    deletions: api.deletions,
  } as ChangedFile;
  if (status === "renamed" && api.previous_filename) file.previousPath = api.previous_filename;
  if (typeof api.patch === "string") file.patch = api.patch;
  return file;
}

/**
 * The PR's changed files in the gate's shape. A goal baseline also carries its
 * text on the base and the head. A text file whose patch GitHub left out also
 * carries a patch that adds its whole head text, so the cast and ignore check
 * cannot be skipped by making a diff too large to show.
 */
export async function gatherFiles(gh: GitHub, pr: PullRequest): Promise<ChangedFile[]> {
  const files = (await gh.listFiles(pr.repo, pr.number)).map(changedFile);
  for (const file of files) {
    if (BASELINE.test(file.path)) {
      if (file.status !== "added") {
        const base = await gh.readFile(pr.repo, file.previousPath ?? file.path, pr.baseSha);
        if (base !== undefined) file.baseContent = base;
      }
      if (file.status !== "removed") {
        const head = await gh.readFile(pr.repo, file.path, pr.headSha);
        if (head !== undefined) file.headContent = head;
      }
    } else if (file.patch === undefined && file.additions > 0 && file.status !== "removed") {
      const head = await gh.readFile(pr.repo, file.path, pr.headSha);
      if (head !== undefined) file.patch = wholeFileAdded(head);
    }
  }
  return files;
}

/** A unified diff that adds every line of `content`. */
export function wholeFileAdded(content: string): string {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

/**
 * Decides the PR against the policy text from main. Returns the decision, or
 * the error that kept the gate from deciding. Never throws.
 */
export async function runGate(
  gh: GitHub,
  pr: PullRequest,
  policyText: () => string,
): Promise<{ decision: Decision } | { error: unknown }> {
  try {
    const policy: unknown = JSON.parse(policyText());
    const files = await gatherFiles(gh, pr);
    const input = parseInput({ pr: { author: pr.author, fromFork: pr.fromFork }, policy, files });
    return { decision: decide(input) };
  } catch (error) {
    return { error };
  }
}

/** The check run for a decision. */
export function reportFor(decision: Decision): CheckReport {
  if (decision.verdict === "qualifies") {
    return {
      title: decision.action === "merge" ? "qualifies" : "would merge itself",
      summary: fit(decision.summary),
      conclusion: "success",
    };
  }
  const n = decision.reasons.length;
  return {
    title: `needs you: ${n} ${n === 1 ? "reason" : "reasons"}`,
    summary: fit(decision.summary),
    conclusion: "neutral",
  };
}

/** The check run when the gate could not decide. */
export function errorReport(error: unknown): CheckReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: "needs you: the gate could not decide",
    summary: fit(
      [
        "**Merge gate: needs-you.** The gate could not decide, so this PR waits for you.",
        "",
        "```",
        message.replaceAll("```", "'''"),
        "```",
      ].join("\n"),
    ),
    conclusion: "neutral",
  };
}

function fit(summary: string): string {
  if (summary.length <= SUMMARY_LIMIT) return summary;
  const note = "\n\n…cut to fit GitHub's limit. The job summary has the rest.";
  return summary.slice(0, SUMMARY_LIMIT - note.length) + note;
}

function field(v: unknown, key: string): unknown {
  const out = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  if (typeof out !== "object" || out === null) throw new Error(`event field ${key} is missing`);
  return out;
}

function text(v: unknown, key: string): string {
  const out = (v as Record<string, unknown>)[key];
  if (typeof out !== "string" || out === "") throw new Error(`event field ${key} is missing`);
  return out;
}
