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

/**
 * A run still marked running this long after it started is treated as
 * interrupted: the process that owned it restarted or crashed before it could
 * record an outcome. A dream over a day of history finishes well inside this.
 */
export const STALE_RUN_MS = 60 * 60 * 1000;

type RunViewStatus = RunStatus | "interrupted";

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
  if (run.status === "running" && now - run.startedAt.getTime() > STALE_RUN_MS) {
    return "interrupted";
  }
  return run.status;
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
        // A skill written at any point in the run was created by it.
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
