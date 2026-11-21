// Acts on the gate's decision for one head commit and writes the `merge gate`
// check run. The gate never merges a PR itself: it only turns GitHub's
// auto-merge on or off, and GitHub merges once every required check on the head
// commit is green. With the policy's `enabled` false it makes no auto-merge call
// at all.
//
// `merge gate` is a required check, and a new head commit has none until the
// gate writes it. On `merge` the gate first writes the run as in progress, so
// the PR is not yet mergeable when auto-merge is turned on: GitHub refuses to
// turn auto-merge on for a PR it could merge at once. Turning auto-merge off
// before a neutral run closes the window in which a commit that no longer
// qualifies could merge on an earlier commit's decision.
//
// When the last check run write fails, after the client's retries, the gate
// turns auto-merge off again if it left it on, and judge throws so that run.ts
// exits non-zero and the workflow's fallback step completes the run.

import {
  type CheckReport,
  DECIDING,
  disableFailedReport,
  enableFailedReport,
  errorReport,
  type GitHub,
  mergingReport,
  type Outcome,
  type PullRequest,
  reportFor,
  runGate,
} from "./collect.js";

/**
 * Decides the PR, turns auto-merge on or off to match, then writes the check run
 * on `pr.headSha`. `show` receives the report before the check run is written.
 * Throws only when a check run cannot be written. When that is the last write
 * on a `merge` that left auto-merge on, it first tries to turn auto-merge off.
 */
export async function judge(
  gh: GitHub,
  pr: PullRequest,
  policyText: () => string,
  show: (report: CheckReport) => void = () => {},
): Promise<CheckReport> {
  const outcome = await runGate(gh, pr, policyText);
  const { report, autoMergeOn } = await act(gh, pr, outcome);
  show(report);
  try {
    await gh.putCheckRun(pr.repo, pr.headSha, report);
  } catch (error) {
    if (autoMergeOn !== undefined) {
      // Best effort. The fallback step completes the run as needs you, and a
      // PR that needs you must not keep auto-merge on.
      await gh.disableAutoMerge(autoMergeOn).catch(() => {});
    }
    throw error;
  }
  return report;
}

/** What act did: the check run to write, and the PR's node id when it left auto-merge on. */
interface Acted {
  report: CheckReport;
  autoMergeOn?: string;
}

/**
 * Makes the auto-merge calls the outcome calls for and returns the check run to
 * write. On `merge` it also writes the in-progress check run before it turns
 * auto-merge on. Throws only when that check run cannot be written, and then
 * makes no enable call.
 */
async function act(gh: GitHub, pr: PullRequest, outcome: Outcome): Promise<Acted> {
  const report = "decision" in outcome ? reportFor(outcome.decision) : errorReport(outcome.error);
  if (!outcome.enabled) return { report };

  if ("decision" in outcome && outcome.decision.action === "merge") {
    const { decision } = outcome;
    let state: Awaited<ReturnType<GitHub["autoMerge"]>>;
    try {
      state = await gh.autoMerge(pr.repo, pr.number);
    } catch (error) {
      return { report: enableFailedReport(decision, error) };
    }
    await gh.putCheckRun(pr.repo, pr.headSha, DECIDING);
    if (!state.enabled) {
      try {
        await gh.enableAutoMerge(state.pullRequestId, pr.headSha);
      } catch (error) {
        return { report: enableFailedReport(decision, error) };
      }
    }
    return { report: mergingReport(decision), autoMergeOn: state.pullRequestId };
  }

  try {
    const state = await gh.autoMerge(pr.repo, pr.number);
    if (state.enabled) await gh.disableAutoMerge(state.pullRequestId);
  } catch (error) {
    // A failed read leaves it as unknown as a failed disable whether auto-merge
    // is on, so both block the merge.
    return { report: disableFailedReport(report, error) };
  }
  return { report };
}
