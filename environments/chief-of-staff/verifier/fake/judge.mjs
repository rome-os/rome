#!/usr/bin/env node
// A deterministic judge for the verifier's tests. It grades the structured input by word
// matching, standing in for the model so the tests need no model login.
import { readFileSync } from "node:fs";

const { input } = JSON.parse(readFileSync(0, "utf8"));
const lower = (s) => String(s ?? "").toLowerCase();
const answer = lower(input.answer);
const stripLinks = (s) =>
  lower(s)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

function sheetItems(sheet) {
  return sheet
    .split("\n")
    .map((line) =>
      [...line.matchAll(/"([^"]+)"|owner ([^,]+)|date (\S+)|^- ([^:]+):/g)].map((m) =>
        lower(m[1] ?? m[2] ?? m[3] ?? m[4]).trim(),
      ),
    );
}

let verdict;
switch (input.task) {
  case "matches-sheet": {
    const items = sheetItems(input.sheet);
    const missing = items.flat().filter((piece) => !answer.includes(piece));
    const extra = answer.split("\n").filter((l) => l.startsWith("- ")).length - items.length;
    verdict =
      missing.length > 0
        ? { verdict: "fail", reasons: `missing ${missing.join(", ")}` }
        : extra > 0
          ? { verdict: "fail", reasons: `${extra} items not on the sheet` }
          : { verdict: "pass", reasons: "every sheet item present, nothing extra" };
    break;
  }
  case "answers-question":
    verdict = answer.includes(lower(input.sheet))
      ? { verdict: "pass", reasons: "gives the sheet's answer" }
      : { verdict: "fail", reasons: `expected ${input.sheet}` };
    break;
  case "says-unknown":
    verdict = /don't know|do not know|no record|nobody has/.test(answer)
      ? { verdict: "pass", reasons: "says it does not know" }
      : { verdict: "fail", reasons: "states an answer nobody gave" };
    break;
  case "same-facts":
    verdict =
      stripLinks(input.before) === stripLinks(input.answer)
        ? { verdict: "pass", reasons: "same facts" }
        : { verdict: "fail", reasons: "answers differ" };
    break;
  default:
    verdict = { verdict: "fail", reasons: `unknown task ${input.task}` };
}
console.log(JSON.stringify(verdict));
