#!/usr/bin/env node
// verify [--rules K1,A5] [--phase 1] [--dirty] [--cos-env "<command>"] [--judge "<command>"]
//        [--out <dir>] [--reply-wait <s>] [--a1-wait <s>] [--poll <s>]
// Scores the chief of staff agent against the rules from the chat alone. See README.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cosEnv } from "./lib/cos-env.mjs";
import { JUDGE_PROMPT_VERSION, makeJudge } from "./lib/judge.mjs";
import { verify } from "./lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    rules: { type: "string" },
    phase: { type: "string" },
    dirty: { type: "boolean", default: false },
    "cos-env": { type: "string", default: join(here, "..", "cos-env") },
    "agent-author": { type: "string", default: "agent" },
    judge: { type: "string", default: `node ${join(here, "lib", "claude-judge.mjs")}` },
    out: { type: "string" },
    "runs-dir": { type: "string" },
    "reply-wait": { type: "string", default: "300" },
    "a1-wait": { type: "string", default: "150" },
    poll: { type: "string", default: "5" },
  },
});

const words = (s) => s.split(" ").filter(Boolean);
const seconds = (s) => Math.round(Number(s) * 1000);
const judgeCommand = values.judge.includes("claude-judge.mjs")
  ? `claude-judge (${process.env.COS_JUDGE_MODEL || "claude-haiku-5-5"})`
  : values.judge;
const judgeName = `${judgeCommand}, prompt ${JUDGE_PROMPT_VERSION}`;

try {
  const { report, outDir } = await verify({
    env: cosEnv({ command: words(values["cos-env"]), agentAuthor: values["agent-author"] }),
    judge: makeJudge(words(values.judge)),
    judgeName,
    rules: values.rules?.split(",").map((r) => r.trim().toUpperCase()),
    phase: values.phase ? Number(values.phase) : undefined,
    waits: {
      replyMs: seconds(values["reply-wait"]),
      a1Ms: seconds(values["a1-wait"]),
      pollMs: seconds(values.poll),
    },
    allowDirty: values.dirty,
    runsDir: values["runs-dir"],
    outDir: values.out,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  if (report.stopped) {
    console.log(report.stopped);
    console.log(`report: ${join(outDir, "report.md")}`);
    process.exit(2);
  }
  console.log(
    `answered ${report.answered.answered} of ${report.answered.sent} messages sent to the agent`,
  );
  for (const r of report.results)
    console.log(`${r.rule}\t${r.status}${r.partial ? " (partly checked)" : ""}\t${r.reason}`);
  console.log(`report: ${join(outDir, "report.md")}`);
  process.exit(report.summary.agentFailures > 0 ? 1 : 0);
} catch (error) {
  console.error(`verify: ${error.message}`);
  process.exit(2);
}
