import { isAbsolute, relative, resolve } from "node:path";
import type { AgentEvent } from "@rome-os/app-runtime";
import type { RunsRepository } from "../db/repositories/runs.js";
import { changesFromToolUse, type FileChange } from "./changes.js";
import { HEARTBEAT_MS } from "./run-view.js";

type RunOutcome = Parameters<RunsRepository["finish"]>[1];

/** Tools that write a file the agent names. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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
  /** Target of each file-writing tool call in flight; null when it named none. */
  private readonly pendingWrites = new Map<string, string | null>();
  /** Every target a file-writing tool call succeeded on, recorded or not. */
  private readonly written: Array<string | null> = [];
  summary = "";
  error: string | null = null;
  private interrupted = false;

  /**
   * @param ignoredDir Changes under it are not recorded: the action records
   *   the authoritative version of what the agent writes there.
   */
  constructor(
    private readonly repo: RunsRepository,
    private readonly runId: string,
    private readonly ignoredDir?: string,
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
      if (WRITE_TOOLS.has(event.tool)) {
        const target = (event.input as { file_path?: unknown } | null)?.file_path;
        this.pendingWrites.set(event.id, typeof target === "string" ? target : null);
      }
      const ignored = this.ignoredDir ? `${this.ignoredDir}/` : null;
      const changes = changesFromToolUse(event.tool, event.input).filter(
        (change) => !ignored || !change.path.startsWith(ignored),
      );
      if (changes.length > 0) this.pending.set(event.id, changes);
      return;
    }
    if (event.type === "tool_result") {
      if (this.pendingWrites.has(event.toolUseId)) {
        if (!event.isError) this.written.push(this.pendingWrites.get(event.toolUseId) ?? null);
        this.pendingWrites.delete(event.toolUseId);
      }
      const changes = this.pending.get(event.toolUseId);
      if (!changes) return;
      this.pending.delete(event.toolUseId);
      if (event.isError) return;
      this.repo.addChanges(this.runId, changes);
    }
  }

  /**
   * Whether the agent wrote anything outside `dir`, including paths the run
   * record leaves out (`.git`, dependencies). A write that named no path
   * counts, so the check fails closed.
   */
  wroteOutside(dir: string): boolean {
    const root = resolve(dir);
    return this.written.some((target) => {
      if (target === null) return true;
      const rel = relative(root, resolve(target));
      return rel.startsWith("..") || isAbsolute(rel);
    });
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
