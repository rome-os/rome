import type { Action, ActionConfig, ActionResult } from "../../actions/types.js";

// buildAction — Action factory with defaults, for registering real actions
// into the testkit's real ActionRegistry/ActionEngine.

const DEFAULT_ACTION_CONFIG: Omit<ActionConfig, "name"> = {
  type: "system",
  description: "test action",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
};

export interface BuildActionOverrides extends Partial<Omit<ActionConfig, "name">> {
  execute?: (args: Record<string, unknown>) => Promise<ActionResult>;
  inputSchema?: Record<string, unknown>;
}

export function buildAction(name: string, overrides: BuildActionOverrides = {}): Action {
  const { execute, inputSchema, ...configOverrides } = overrides;
  return {
    config: { ...DEFAULT_ACTION_CONFIG, name, ...configOverrides },
    // Agent-callable by default — event-only actions can pass inputSchema: undefined explicitly.
    inputSchema: "inputSchema" in overrides ? inputSchema : { type: "object", properties: {} },
    execute: execute ?? (async () => ({ status: "ok" })),
  };
}

/**
 * An action that records every invocation. The default testkit replacement
 * for `rs.fn()`-stubbed engines: the action really executes through the real
 * engine, and the test asserts on what reached it (plus the DB rows the
 * engine wrote).
 */
export interface RecordingAction {
  action: Action;
  calls: Record<string, unknown>[];
}

export function recordingAction(
  name: string,
  overrides: BuildActionOverrides = {},
): RecordingAction {
  const calls: Record<string, unknown>[] = [];
  const inner = overrides.execute;
  const action = buildAction(name, {
    ...overrides,
    execute: async (args) => {
      calls.push(args);
      return inner ? await inner(args) : { status: "ok", data: { recorded: true } };
    },
  });
  return { action, calls };
}
