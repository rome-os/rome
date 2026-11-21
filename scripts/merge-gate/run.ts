// Entry point of .github/workflows/merge-gate.yml. Decides the event's pull
// request and reports the decision as the `merge gate` check run on its head
// commit and in the job summary.
//
// Reads GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_API_URL and GITHUB_STEP_SUMMARY,
// and the policy at .github/merge-policy.json under the working directory, which
// the workflow checks out from main. Always exits 0, so the gate never fails a PR.

import { appendFileSync, readFileSync } from "node:fs";
import { type CheckReport, errorReport, pullRequestFrom, reportFor, runGate } from "./collect.js";
import { restClient } from "./github.js";

const POLICY_FILE = ".github/merge-policy.json";

async function main(): Promise<void> {
  const env = process.env;
  const event: unknown = JSON.parse(
    readFileSync(required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH"), "utf8"),
  );
  const pr = pullRequestFrom(event);
  const gh = restClient({
    token: required(env.GITHUB_TOKEN, "GITHUB_TOKEN"),
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
  });

  const outcome = await runGate(gh, pr, () => readFileSync(POLICY_FILE, "utf8"));
  let report: CheckReport;
  if ("decision" in outcome) {
    report = reportFor(outcome.decision);
    if (outcome.decision.action === "merge") {
      // PHASE 3: merge here. Phase 1 only reports, whatever `enabled` says, so
      // nothing in this branch acts on the PR.
    }
  } else {
    report = errorReport(outcome.error);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## merge gate: ${report.title}\n\n${report.summary}\n`,
    );
  }
  console.log(`merge gate: ${report.title}`);
  await gh.putCheckRun(pr.repo, pr.headSha, report);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((err: unknown) => {
  // Reached only when the event cannot be read or the check run cannot be
  // written. The PR then carries no decision, so the log says why.
  const message = err instanceof Error ? err.message : String(err);
  console.log(`::warning title=merge gate::the gate could not report: ${message}`);
});
