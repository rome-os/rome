import type { AgentMessage } from "../../types.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
  type ModelSession,
  type ModelSessionParams,
} from "../../core/agent-runner.js";
import { createPiModelRuntime, runPiPrototypeTurn } from "./pi-sdk-prototype.js";

/**
 * Thin, intentionally incomplete adapter used only by the opt-in Rome UI
 * prototype. Every turn gets an in-memory Pi session, so Pi history, built-in
 * tools, extensions, and files never become an alternate source of truth.
 */
export class PiPrototypeModelProvider implements ModelProvider {
  readonly id = "pi" as const;
  readonly displayName = "Pi Coding Agent (prototype)";
  readonly builtinTools = new Set<string>();

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const runtime = await createPiModelRuntime();
    return createSessionFromRun(this.id, (turn) => this.run(runtime, turn), params);
  }

  private async *run(
    runtime: Awaited<ReturnType<typeof createPiModelRuntime>>,
    params: ModelRunParams,
  ): AsyncIterable<AgentMessage> {
    const buffered: AgentMessage[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: unknown;

    void runPiPrototypeTurn({
      runtime,
      qualifiedModelId: params.model,
      prompt: params.prompt,
      cwd: params.workingDir,
      systemPrompt: params.systemPrompt,
      emit(message) {
        buffered.push(message);
        wake?.();
        wake = undefined;
      },
    })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        wake?.();
        wake = undefined;
      });

    while (!finished || buffered.length > 0) {
      if (buffered.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield buffered.shift()!;
    }
    if (failure) throw failure;
  }
}
