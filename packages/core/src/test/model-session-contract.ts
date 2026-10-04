import { expect } from "@rstest/core";
import type { ModelSessionEvent } from "../core/agent-runner.js";

/**
 * Shared contract assertion for every ModelSession implementation. Model turns
 * bracket their provider messages, retain one stable id, and finish only after
 * one terminal result/error. Implementations may learn input echoes at start
 * or add them later with model_turn_answers.
 */
export function expectModelSessionTurnContract(
  events: ModelSessionEvent[],
  { allowUnfinished = false }: { allowUnfinished?: boolean } = {},
): void {
  let current:
    | {
        turnId: string;
        answers: Set<string>;
        terminal: boolean;
      }
    | undefined;
  let completed = 0;

  for (const event of events) {
    switch (event.type) {
      case "model_turn_start":
        expect(current).toBeUndefined();
        current = { turnId: event.turnId, answers: new Set(event.answers), terminal: false };
        break;
      case "model_turn_answers":
        expect(current?.turnId).toBe(event.turnId);
        for (const id of event.added) {
          expect(current!.answers.has(id)).toBe(false);
          current!.answers.add(id);
        }
        break;
      case "model_turn_end":
        expect(current?.turnId).toBe(event.turnId);
        expect(current?.terminal).toBe(true);
        expect(event.answers).toEqual([...current!.answers]);
        current = undefined;
        completed++;
        break;
      case "result":
      case "error":
        expect(current).toBeDefined();
        expect(current?.terminal).toBe(false);
        current!.terminal = true;
        break;
      default:
        expect(current).toBeDefined();
    }
  }

  if (allowUnfinished && current) {
    // A provider process can die after start without a terminal. The session
    // must leave that turn unclosed so AgentSession can fail waiting callers
    // rather than inventing an SDK result/end pair.
    expect(current.terminal).toBe(false);
  } else {
    expect(current).toBeUndefined();
  }
  expect(completed + (current ? 1 : 0)).toBeGreaterThan(0);
}
