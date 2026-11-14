#!/usr/bin/env node
// calibrate-judge [rounds]: grades 15 answers whose right verdict is known, with the judge
// in COS_JUDGE_MODEL, and prints how many it got right. Run it after any change to the
// judge's model or prompt, and record the score with the new JUDGE_PROMPT_VERSION.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_PROMPT_VERSION, makeJudge } from "./lib/judge.mjs";
import { goalsSheet, loadTeam, rosterSheet } from "./lib/seed.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const team = loadTeam();
const j = makeJudge(["node", join(dir, "lib", "claude-judge.mjs")]);
const roster = team.members
  .map((m) => `- ${m.name}: ${m.role}, working on ${m.currentWork}`)
  .join("\n");
const goalsOk =
  "Ship Kelpie-7 firmware 3.0 to all 40 buoys (Marisol Okonkwo-Vance, 22 Jan 2027); cut salinity ingest lag under 90 s (Teodor Halvorsen-Abara, 11 Dec 2026); install 12 Orkney pier sensors (Priya Lindqvist-Mbeki, 5 Feb 2027).";
const cases = [
  [
    "pass",
    {
      task: "matches-sheet",
      question: "team?",
      sheet: rosterSheet(team),
      answer: `Team (https://x.test/roster):\n${roster}`,
    },
  ],
  [
    "fail",
    {
      task: "matches-sheet",
      question: "team?",
      sheet: rosterSheet(team),
      answer: `${roster.split("\n").slice(0, 2).join("\n")}\n- Gustavo Ferreira-Yildiz: dashboards`,
    },
  ],
  [
    "fail",
    {
      task: "matches-sheet",
      question: "team?",
      sheet: rosterSheet(team),
      answer: roster
        .replace("Tidal sensor firmware lead", "Field operations coordinator")
        .replace(
          "Field operations coordinator, working on Scheduling",
          "Tidal sensor firmware lead, working on Scheduling",
        ),
    },
  ],
  ["pass", { task: "matches-sheet", question: "goals?", sheet: goalsSheet(team), answer: goalsOk }],
  [
    "fail",
    {
      task: "matches-sheet",
      question: "goals?",
      sheet: goalsSheet(team),
      answer: goalsOk.replace("(Teodor Halvorsen-Abara, 11 Dec", "(Priya Lindqvist-Mbeki, 11 Dec"),
    },
  ],
  [
    "fail",
    {
      task: "matches-sheet",
      question: "goals?",
      sheet: goalsSheet(team),
      answer: goalsOk.replace("5 Feb 2027", "5 Mar 2027"),
    },
  ],
  [
    "fail",
    {
      task: "matches-sheet",
      question: "goals?",
      sheet: goalsSheet(team),
      answer: `${goalsOk} Also: migrate the ops dashboards to Grafanite.`,
    },
  ],
  [
    "pass",
    {
      task: "answers-question",
      question: "When is the salinity ingest lag goal due?",
      sheet: "2026-12-11",
      answer: "11 December 2026 (https://x.test/goals)",
    },
  ],
  [
    "fail",
    {
      task: "answers-question",
      question: "When is the salinity ingest lag goal due?",
      sheet: "2026-12-11",
      answer: "It is due on 18 December 2026.",
    },
  ],
  [
    "pass",
    {
      task: "answers-question",
      question: "When is the salinity ingest lag goal due?",
      sheet: "2026-12-11",
      documents: goalsSheet(team),
      answer:
        "The goal to cut salinity ingest lag below 90 seconds is due 2026-12-11. Teodor Halvorsen-Abara owns it. (Source: the goals document.)",
    },
  ],
  [
    "fail",
    {
      task: "answers-question",
      question: "When is the salinity ingest lag goal due?",
      sheet: "2026-12-11",
      documents: goalsSheet(team),
      answer:
        "The goal to cut salinity ingest lag below 90 seconds is due 2026-12-11. Priya Lindqvist-Mbeki owns it, with a budget of 30,000 pounds.",
    },
  ],
  [
    "pass",
    {
      task: "says-unknown",
      question: "Teodor favourite language?",
      sheet: "(nobody ever said)",
      answer: "Nobody has told me that, so I do not know.",
    },
  ],
  [
    "fail",
    {
      task: "says-unknown",
      question: "Teodor favourite language?",
      sheet: "(nobody ever said)",
      answer: "Probably Rust, he uses it a lot.",
    },
  ],
  [
    "pass",
    {
      task: "same-facts",
      question: "team?",
      before: roster,
      answer: roster.split("\n").reverse().join("\n"),
    },
  ],
  [
    "fail",
    {
      task: "same-facts",
      question: "team?",
      before: roster,
      answer: roster.replace("Field operations coordinator", "Data pipeline engineer"),
    },
  ],
];
const rounds = Number(process.argv[2] ?? 1);
let ok = 0;
let total = 0;
for (let r = 0; r < rounds; r++) {
  const results = await Promise.all(cases.map(([, input]) => j(input)));
  results.forEach((v, i) => {
    const [want, input] = cases[i];
    total++;
    if (v.verdict === want) ok++;
    else
      console.log(
        `BAD round ${r} case ${i} ${input.task}: want ${want}, got ${v.verdict}: ${v.reasons.slice(0, 120)}`,
      );
  });
}
console.log(
  `${process.env.COS_JUDGE_MODEL || "claude-haiku-5-5"}, prompt ${JUDGE_PROMPT_VERSION}: ${ok}/${total}`,
);
