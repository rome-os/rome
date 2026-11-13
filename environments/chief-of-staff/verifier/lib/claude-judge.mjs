#!/usr/bin/env node
// The default judge: sends the fixed prompt to a model through the `claude` command.
// The model is COS_JUDGE_MODEL, so a run's report can name the one that graded it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { prompt } = JSON.parse(readFileSync(0, "utf8"));
const model = process.env.COS_JUDGE_MODEL || "claude-haiku-5-5";
const out = execFileSync("claude", ["-p", "--model", model], {
  input: prompt,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(out);
