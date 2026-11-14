// A model as judge, for checks that compare an answer with the answer sheet.
// The judge is a command: it reads `{ prompt, input }` as JSON on stdin and prints
// `{ verdict, reasons }`. The default, claude-judge.mjs, sends the prompt to a model;
// the verifier's tests use fake/judge.mjs, which grades `input` by token matching.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const template = readFileSync(new URL("judge-prompt.md", import.meta.url), "utf8");

// The judge prompt's version. A change to judge-prompt.md bumps it, so a report always names
// the prompt its verdicts came from. A judge change is a verifier change.
export const JUDGE_PROMPT_VERSION = "J4";

// The last calibration of JUDGE_PROMPT_VERSION (calibrate-judge.mjs), stated in every report.
export const JUDGE_CALIBRATION = "60 of 60 over 3 rounds on claude-haiku-5-5 (2026-11-14)";

const TASKS = ["matches-sheet", "answers-question", "says-unknown", "same-facts"];

function judgePrompt(input) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => input[field] ?? "(none)");
}

/**
 * Returns a function that grades `{ task, question, sheet, answer, before, documents }` and resolves to
 * `{ verdict, reasons, prompt }`. A judge that fails or prints no verdict resolves to
 * verdict "error", which the runner reports as not checked.
 */
export function makeJudge(command) {
  const [bin, ...fixed] = command;
  return (input) =>
    new Promise((resolve) => {
      if (!TASKS.includes(input.task)) throw new Error(`unknown judge task ${input.task}`);
      const prompt = judgePrompt(input);
      const child = execFile(
        bin,
        fixed,
        { maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              verdict: "error",
              reasons: `judge failed: ${stderr || error.message}`,
              prompt,
            });
            return;
          }
          resolve({ ...parseVerdict(stdout), prompt });
        },
      );
      child.stdin.end(JSON.stringify({ prompt, input }));
    });
}

/** Takes the last JSON object in `text` that carries a verdict. */
export function parseVerdict(text) {
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.verdict === "pass" || parsed.verdict === "fail") {
        return { verdict: parsed.verdict, reasons: String(parsed.reasons ?? "") };
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return { verdict: "error", reasons: `judge printed no verdict: ${text.slice(0, 200)}` };
}
