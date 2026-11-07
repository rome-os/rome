import type { AgentEvent } from "@rome-os/app-runtime";
import type { RunsRepository } from "../db/repositories/runs.js";
import { fileChangesFromToolUse, isWithin, type FileChange } from "./changes.js";
import { HEARTBEAT_MS } from "./run-view.js";

type RunOutcome = Parameters<RunsRepository["finish"]>[1];

/** The text of a tool result: a string, or content blocks, bare or in an envelope. */
function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(resultText).join("");
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("content" in record) return resultText(record.content);
  }
  return "";
}

/**
 * An action that fails returns `{ status: "error" }` as an ordinary tool
 * result, without the error flag, so its output has to be read.
 */
function reportsActionError(output: unknown): boolean {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    if ((output as Record<string, unknown>).status === "error") return true;
  }
  const text = resultText(output).trim();
  if (!text.startsWith("{")) return false;
  try {
    return (JSON.parse(text) as { status?: unknown }).status === "error";
  } catch {
    return false;
  }
}

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
  private readonly pending = new Map<string, { changes: FileChange[]; knownPaths: string[] }>();
  private readonly knownAppPaths = new Set<string>();
  summary = "";
  error: string | null = null;
  private interrupted = false;

  /**
   * @param appsRoot Changes under it are not recorded directly. The action
   *   records the final filesystem version; paths here mark files the practice
   *   agent explicitly targeted.
   */
  constructor(
    private readonly repo: Pick<RunsRepository, "addChanges">,
    private readonly runId: string,
    private readonly appsRoot?: string,
  ) {}

  /** App paths the practice agent demonstrably touched. */
  knownPaths(): ReadonlySet<string> {
    return this.knownAppPaths;
  }

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
      const { changes: allChanges, paths } = fileChangesFromToolUse(event.tool, event.input);
      const knownPaths = this.appsRoot
        ? [...new Set(paths)].filter((path) => isWithin(path, this.appsRoot!))
        : [];
      const changes = this.appsRoot
        ? allChanges.filter((change) => !isWithin(change.path, this.appsRoot!))
        : allChanges;
      if (changes.length > 0 || knownPaths.length > 0) {
        this.pending.set(event.id, { changes, knownPaths });
      }
      return;
    }
    if (event.type === "tool_result") {
      const pending = this.pending.get(event.toolUseId);
      if (!pending) return;
      this.pending.delete(event.toolUseId);
      if (event.isError || reportsActionError(event.output)) return;
      for (const path of pending.knownPaths) {
        this.knownAppPaths.add(path);
      }
      if (pending.changes.length > 0) {
        this.repo.addChanges(this.runId, pending.changes);
      }
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
