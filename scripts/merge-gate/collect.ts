// Builds the merge gate's input for one pull request from the GitHub API,
// decides it, and turns the decision into the `merge gate` check run. The
// workflow is .github/workflows/merge-gate.yml and its entry point is run.ts.
//
// The PR reaches the gate only as data: its changed files with their patches,
// and the text of a changed goal baseline. Nothing from the PR's head is
// checked out, imported or run.

import { BASELINE, type ChangedFile, type Decision, decide, SUMMARY_HEAD } from "./gate.js";
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
  /** `failure` only when auto-merge could not be turned off, so the required check blocks the merge. */
  conclusion: "success" | "neutral" | "failure";
}

/** A check run that is still running: it has no conclusion yet, so it holds the required check pending. */
export interface PendingReport {
  title: string;
  summary: string;
  conclusion: null;
}

/** A PR's auto-merge state, as the API reports it at the time of the call. */
export interface AutoMerge {
  /** The PR's GraphQL node id, which the auto-merge mutations take. */
  pullRequestId: string;
  enabled: boolean;
}

/** The GitHub calls the collector makes, so tests can fake them. */
export interface GitHub {
  /** Every changed file of the PR, across all pages. */
  listFiles(repo: string, number: number): Promise<ApiFile[]>;
  /** The file's text at `ref`, or undefined when no file exists there. */
  readFile(repo: string, path: string, ref: string): Promise<string | undefined>;
  /**
   * Creates the check run on `headSha`, or updates the one this workflow made
   * there before. A report with a null conclusion leaves the run `in_progress`.
   */
  putCheckRun(repo: string, headSha: string, report: CheckReport | PendingReport): Promise<void>;
  /** Reads whether auto-merge is on for the PR. */
  autoMerge(repo: string, number: number): Promise<AutoMerge>;
  /** Turns auto-merge on with the squash method. GitHub refuses it once the head is no longer `headSha`. */
  enableAutoMerge(pullRequestId: string, headSha: string): Promise<void>;
  /** Turns auto-merge off. Throws when GitHub refuses, such as when it is already off. */
  disableAutoMerge(pullRequestId: string): Promise<void>;
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
 * What the gate concluded for one PR: the decision, or the error that kept it
 * from deciding. `enabled` is the policy's `enabled`, and true whenever the
 * policy cannot be read, so an unreadable policy never leaves auto-merge on.
 */
export type Outcome = ({ decision: Decision } | { error: unknown }) & { enabled: boolean };

/** Decides the PR against the policy text from main. Never throws. */
export async function runGate(
  gh: GitHub,
  pr: PullRequest,
  policyText: () => string,
): Promise<Outcome> {
  let enabled = true;
  try {
    const policy: unknown = JSON.parse(policyText());
    enabled = enabledIn(policy);
    const files = await gatherFiles(gh, pr);
    const input = parseInput({ pr: { author: pr.author, fromFork: pr.fromFork }, policy, files });
    return { decision: decide(input), enabled };
  } catch (error) {
    return { error, enabled };
  }
}

/**
 * The policy's `enabled` when it is a boolean, else true. A policy that parses
 * but is malformed elsewhere still says whether a person switched the gate on.
 */
function enabledIn(policy: unknown): boolean {
  const value =
    typeof policy === "object" && policy !== null
      ? (policy as Record<string, unknown>).enabled
      : undefined;
  return typeof value === "boolean" ? value : true;
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

/** The line after the blank line of a `merge` summary once auto-merge is on. */
export const MERGING_LINE =
  "Every changed path is listed in the merge policy, so this PR merges itself once its required checks pass.";

/** The check run for a `merge` decision once auto-merge is on for the head commit. */
export function mergingReport(decision: Decision): CheckReport {
  const lines = decision.summary.split("\n");
  lines[2] = MERGING_LINE;
  return { ...reportFor(decision), summary: fit(lines.join("\n")) };
}

/** The in-progress check run a `merge` decision writes before it turns auto-merge on. */
export const DECIDING: PendingReport = {
  title: "deciding",
  summary: "The gate is turning auto-merge on for this commit.",
  conclusion: null,
};

/**
 * The check run for a `merge` decision when auto-merge could not be turned on,
 * or whether it was on could not be read.
 */
export function enableFailedReport(decision: Decision, error: unknown): CheckReport {
  const lines = decision.summary.split("\n");
  lines.splice(3, 0, "", `Auto-merge could not be turned on: ${messageOf(error)}.`);
  return {
    title: "qualifies, but auto-merge could not be turned on",
    summary: fit(lines.join("\n")),
    conclusion: "neutral",
  };
}

/**
 * The check run when auto-merge may still be on for a PR that needs you: turning
 * it off failed, or reading whether it was on failed. `report` is the check run
 * the gate would write otherwise.
 */
export function disableFailedReport(report: CheckReport, error: unknown): CheckReport {
  const lines = report.summary.split("\n");
  lines.splice(3, 0, "", `Auto-merge could not be turned off: ${messageOf(error)}.`);
  return {
    title: "needs you: auto-merge could not be turned off",
    summary: fit(lines.join("\n")),
    conclusion: "failure",
  };
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\.$/, "");
}

/** The check run when the gate could not decide. */
export function errorReport(error: unknown): CheckReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: "needs you: the gate could not decide",
    summary: fit(
      [
        SUMMARY_HEAD.needsYou,
        "",
        "The gate could not decide, so this PR waits for you.",
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
