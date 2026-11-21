// Entry point of .github/workflows/merge-gate.yml. Decides the event's pull
// request, turns auto-merge on or off to match (act.ts), and reports the
// decision as the `merge gate` check run on its head commit and in the job
// summary.
//
// Reads GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_API_URL and GITHUB_STEP_SUMMARY,
// and the policy at .github/merge-policy.json under the working directory, which
// the workflow checks out from main. Exits 0 whatever the gate decides, so the
// gate never fails a PR, except when the check run cannot be written after
// retries: it then exits 1, so the workflow's fallback step completes the run
// instead of leaving the required check in progress.

import { appendFileSync, readFileSync } from "node:fs";
import { judge } from "./act.js";
import { pullRequestFrom } from "./collect.js";
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

  try {
    await judge(
      gh,
      pr,
      () => readFileSync(POLICY_FILE, "utf8"),
      (report) => {
        if (env.GITHUB_STEP_SUMMARY) {
          appendFileSync(
            env.GITHUB_STEP_SUMMARY,
            `## merge gate: ${report.title}\n\n${report.summary}\n`,
          );
        }
        console.log(`merge gate: ${report.title}`);
      },
    );
  } catch (err) {
    console.log(`::error title=merge gate::the check run could not be written: ${messageOf(err)}`);
    process.exitCode = 1;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((err: unknown) => {
  // Reached only when the event or the token cannot be read. The head commit
  // then has no `merge gate` check run, which main requires, so the PR cannot
  // merge, and the log says why.
  console.log(`::warning title=merge gate::the gate could not report: ${messageOf(err)}`);
});
