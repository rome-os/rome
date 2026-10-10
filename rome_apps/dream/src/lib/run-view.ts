import type { Run, RunKind, RunStatus } from "../db/repositories/runs.js";
import {
  classifyPath,
  groupByFile,
  type ChangedFile,
  type ChangeOp,
  type FileChange,
} from "./changes.js";

/**
 * The run shapes the API serves. The web bundle imports these as types only,
 * so the page and the API cannot drift apart.
 */

/** How often an action refreshes its run's heartbeat while it works. */
export const HEARTBEAT_MS = 60 * 1000;

/**
 * An active run whose heartbeat is older than this has lost its owner: the
 * process restarted or crashed before it could record an outcome. It shows as
 * interrupted and stops blocking the next dream. A run's age alone never
 * expires it, because nothing can stop an agent that is still working.
 */
export const STALE_RUN_MS = 10 * HEARTBEAT_MS;

/** A queued run shows as running: the page started it and the agent is on its way. */
type RunViewStatus = Exclude<RunStatus, "queued"> | "interrupted";

interface RunOutcome {
  journal: boolean;
  memoryFiles: number;
  skills: Array<{ name: string; op: ChangeOp }>;
  otherFiles: number;
}

export interface RunListItem {
  id: string;
  kind: RunKind;
  status: RunViewStatus;
  startedAt: string;
  finishedAt: string | null;
  windowHours: number | null;
  reviewedSession: { id: string; name: string | null } | null;
  outcome: RunOutcome;
}

export interface RunDetail extends RunListItem {
  summary: string | null;
  error: string | null;
  files: ChangedFile[];
}

export interface DreamSchedule {
  enabled: boolean;
  nextRunAt: string | null;
}

function viewStatus(run: Run, now: number): RunViewStatus {
  if (run.status !== "queued" && run.status !== "running") return run.status;
  const lastSeen = (run.heartbeatAt ?? run.startedAt).getTime();
  return now - lastSeen > STALE_RUN_MS ? "interrupted" : "running";
}

function summarizeOutcome(changes: Array<Pick<FileChange, "op" | "path">>): RunOutcome {
  const memory = new Set<string>();
  const other = new Set<string>();
  const skills = new Map<string, ChangeOp>();
  let journal = false;

  for (const { op, path } of changes) {
    const file = classifyPath(path);
    switch (file.area) {
      case "journal":
        journal = true;
        break;
      case "memory":
        memory.add(path);
        break;
      case "skill": {
        const name = file.skillName ?? path;
        // A full write wins over edits, so the row says the skill was saved.
        if (skills.get(name) !== "write") skills.set(name, op);
        break;
      }
      case "other":
        other.add(path);
        break;
    }
  }

  return {
    journal,
    memoryFiles: memory.size,
    skills: [...skills].map(([name, op]) => ({ name, op })),
    otherFiles: other.size,
  };
}

export function toListItem(
  run: Run,
  changes: Array<Pick<FileChange, "op" | "path">>,
  now: number,
): RunListItem {
  return {
    id: run.id,
    kind: run.kind,
    status: viewStatus(run, now),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    windowHours: run.windowHours,
    reviewedSession: run.reviewedSessionId
      ? { id: run.reviewedSessionId, name: run.reviewedSessionName }
      : null,
    outcome: summarizeOutcome(changes),
  };
}

export function toDetail(run: Run, changes: FileChange[], now: number): RunDetail {
  return {
    ...toListItem(run, changes, now),
    summary: run.summary,
    error: run.error,
    files: groupByFile(changes),
  };
}
