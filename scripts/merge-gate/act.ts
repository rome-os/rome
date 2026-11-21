// Acts on the gate's decision for one head commit and writes the `merge gate`
// check run. The gate never merges a PR itself: it only turns GitHub's
// auto-merge on or off, and GitHub merges once every required check on the head
// commit is green.
//
// `merge gate` is a required check, and a new head commit has none until the
// gate writes it, so every auto-merge call comes before the check run. Turning
// auto-merge off before a neutral run closes the window in which a commit that
// no longer qualifies could merge on an earlier commit's decision.

import {
  type CheckReport,
  disableFailedReport,
  enableFailedReport,
  errorReport,
  type GitHub,
  mergingReport,
  type PullRequest,
  reportFor,
  runGate,
} from "./collect.js";

/**
 * Decides the PR, turns auto-merge on or off to match, then writes the check run
 * on `pr.headSha`. `show` receives the report before the check run is written.
 * Throws only when the check run cannot be written.
 */
export async function judge(
  gh: GitHub,
  pr: PullRequest,
  policyText: () => string,
  show: (report: CheckReport) => void = () => {},
): Promise<CheckReport> {
  const outcome = await runGate(gh, pr, policyText);
  const report = await act(gh, pr, outcome);
  show(report);
  await gh.putCheckRun(pr.repo, pr.headSha, report);
  return report;
}

/**
 * Makes the auto-merge calls the outcome calls for and returns the check run to
 * write. Never throws. `report-only` makes no call that changes the PR.
 */
export async function act(
  gh: GitHub,
  pr: PullRequest,
  outcome: Awaited<ReturnType<typeof runGate>>,
): Promise<CheckReport> {
  if ("decision" in outcome && outcome.decision.action === "report-only") {
    return reportFor(outcome.decision);
  }
  if ("decision" in outcome && outcome.decision.action === "merge") {
    try {
      const { pullRequestId } = await gh.autoMerge(pr.repo, pr.number);
      await gh.enableAutoMerge(pullRequestId, pr.headSha);
    } catch (error) {
      return enableFailedReport(outcome.decision, error);
    }
    return mergingReport(outcome.decision);
  }

  const report = "decision" in outcome ? reportFor(outcome.decision) : errorReport(outcome.error);
  try {
    const state = await gh.autoMerge(pr.repo, pr.number);
    if (state.enabled) await gh.disableAutoMerge(state.pullRequestId);
  } catch (error) {
    // A failed read leaves it as unknown as a failed disable whether auto-merge
    // is on, so both block the merge.
    return disableFailedReport(report, error);
  }
  return report;
}
