import type { AgentEvent } from "@rome-os/app-runtime";
import type { RunsRepository } from "../db/repositories/runs.js";
import { changesFromToolUse, type FileChange } from "./changes.js";
import { HEARTBEAT_MS } from "./run-view.js";

type RunOutcome = Parameters<RunsRepository["finish"]>[1];

/**
 * Watches an agent's event stream and records each file change once its tool
 * call succeeds. A failed `Edit` changed nothing, so a change is held until its
 * `tool_result` arrives and dropped if that result is an error or never comes.
 *
 * It also reads the turn's outcome. A stopped turn can end with a partial
 * `result` or an `error` before `turn_end` reports `interrupted`, and that
 * status wins, so the stream has to be read to its end before classifying.
 */
export class RunRecorder {
  private readonly pending = new Map<string, FileChange[]>();
  summary = "";
  error: string | null = null;
  /** Paths of the file changes whose tool calls succeeded, in order. */
  readonly changedPaths: string[] = [];
  private interrupted = false;

  constructor(
    private readonly repo: RunsRepository,
    private readonly runId: string,
  ) {}

  observe(event: AgentEvent): void {
    if (event.type === "result") {
      this.summary = event.content as string;
      return;
    }
    if (event.type === "error") {
      this.error = event.error;
      return;
    }
    if (event.type === "turn_end") {
      this.interrupted = event.status === "interrupted";
      return;
    }
    if (event.type === "tool_use") {
      const changes = changesFromToolUse(event.tool, event.input);
      if (changes.length > 0) this.pending.set(event.id, changes);
      return;
    }
    if (event.type === "tool_result") {
      const changes = this.pending.get(event.toolUseId);
      if (!changes) return;
      this.pending.delete(event.toolUseId);
      if (event.isError) return;
      this.repo.addChanges(this.runId, changes);
      for (const change of changes) this.changedPaths.push(change.path);
    }
  }

  outcome(): RunOutcome {
    if (this.interrupted) return { status: "interrupted", summary: this.summary };
    if (this.error !== null) return { status: "failed", error: this.error };
    return { status: "completed", summary: this.summary };
  }
}

/**
 * Refreshes the run's heartbeat until the returned function stops it. A run
 * keeps blocking the next dream for as long as this is beating, however long
 * its agent takes.
 */
export function keepRunAlive(runs: RunsRepository, runId: string): () => void {
  const timer = setInterval(() => runs.heartbeat(runId), HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
