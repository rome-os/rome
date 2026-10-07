import type { AgentEvent } from "@rome-os/app-runtime";
import type { RunsRepository } from "../db/repositories/runs.js";
import { changesFromToolUse, type FileChange } from "./changes.js";

/**
 * Watches an agent's event stream and records each file change once its tool
 * call succeeds. A failed `Edit` changed nothing, so a change is held until its
 * `tool_result` arrives and dropped if that result is an error or never comes.
 */
export class RunRecorder {
  private readonly pending = new Map<string, FileChange[]>();

  constructor(
    private readonly repo: RunsRepository,
    private readonly runId: string,
  ) {}

  observe(event: AgentEvent): void {
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
    }
  }
}
