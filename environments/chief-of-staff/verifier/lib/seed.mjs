// The seeded team: the facts the agent is given and the answer sheet its answers are compared with.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const seedDir = new URL("../seed/", import.meta.url);

export function loadTeam() {
  return JSON.parse(readFileSync(new URL("team.json", seedDir), "utf8"));
}

export function loadK5Questions() {
  return JSON.parse(readFileSync(new URL("k5-questions.json", seedDir), "utf8"));
}

function rosterDocument(team) {
  const rows = team.members.map((m) => `| ${m.name} | ${m.role} | ${m.currentWork} |`);
  return [
    "# Team roster",
    "",
    "| Person | Role | Working on now |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function goalsDocument(team) {
  const current = team.goals.map((g) => `| ${g.title} | ${g.owner} | ${g.date} |`);
  const dropped = team.droppedGoals.map(
    (g) => `| ${g.title} | ${g.owner} | Dropped on ${g.dropped} |`,
  );
  return [
    "# Team goals",
    "",
    "## Current",
    "",
    "| Goal | Owner | Date |",
    "| --- | --- | --- |",
    ...current,
    "",
    "## Dropped",
    "",
    "| Goal | Owner | Status |",
    "| --- | --- | --- |",
    ...dropped,
    "",
  ].join("\n");
}

/** The K1 answer sheet as text a judge reads. */
export function rosterSheet(team) {
  return team.members
    .map((m) => `- ${m.name}: role "${m.role}", working on "${m.currentWork}"`)
    .join("\n");
}

/**
 * K1's sheet: the roster, then the current goals as items an answer may also state. The
 * planner (2026-11-17): true goals from the goals document do not count against K1; a wrong,
 * dropped or misowned goal still fails it.
 */
export function teamSheet(team) {
  return `${rosterSheet(team)}\n\n${MAY_ALSO}\n${goalsSheet(team)}`;
}

/** The heading a judge reads for sheet items an answer may state but need not. */
const MAY_ALSO = "May also be stated, only exactly as the goals document has them (not required):";

/** The K2 answer sheet as text a judge reads. */
export function goalsSheet(team) {
  return team.goals.map((g) => `- "${g.title}", owner ${g.owner}, date ${g.date}`).join("\n");
}

/**
 * Writes the documents the environment hands the agent (roster.md, goals.md, team.json) into
 * `dir`, and returns `dir`.
 */
export function writeSeed(team, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roster.md"), rosterDocument(team));
  writeFileSync(join(dir, "goals.md"), goalsDocument(team));
  writeFileSync(join(dir, "team.json"), `${JSON.stringify(team, null, 2)}\n`);
  return dir;
}
