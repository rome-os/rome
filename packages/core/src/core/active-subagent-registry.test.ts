import { describe, expect, it, rs } from "@rstest/core";
import { createActiveSubagentRegistry } from "./active-subagent-registry.js";
import type { SubagentExecution } from "./subagent-execution.js";

function execution(sessionId: string, turnId: string): SubagentExecution {
  return {
    sessionId,
    turnId,
    agentName: "researcher",
    events: {
      async *[Symbol.asyncIterator]() {
        return;
      },
    },
    completion: new Promise(() => undefined),
    interrupt: rs.fn(async () => undefined),
  };
}

describe("ActiveSubagentRegistry", () => {
  it("registers one link in both directions and clears both indexes by Parent", () => {
    const registry = createActiveSubagentRegistry();
    const parent = { sessionId: "parent", turnId: "parent-turn", toolUseId: "tool-1" };
    const child = { sessionId: "child", turnId: "child-turn" };
    const active = execution(child.sessionId, child.turnId);

    registry.register(parent, child, active);

    expect(registry.getLinkByParent(parent)).toEqual({ parent, child, execution: active });
    expect(registry.getLinkByChild(child)).toEqual({ parent, child, execution: active });

    registry.clearByParent(parent);
    expect(registry.getLinkByParent(parent)).toBeUndefined();
    expect(registry.getLinkByChild(child)).toBeUndefined();
  });

  it("rejects duplicate Parent and Child keys", () => {
    const registry = createActiveSubagentRegistry();
    const parent = { sessionId: "parent", turnId: "parent-turn", toolUseId: "tool-1" };
    const child = { sessionId: "child", turnId: "child-turn" };
    registry.register(parent, child, execution(child.sessionId, child.turnId));

    expect(() =>
      registry.register(
        parent,
        { sessionId: "other-child", turnId: "other-turn" },
        execution("other-child", "other-turn"),
      ),
    ).toThrow(/already exists for parent/);

    expect(() =>
      registry.register(
        { sessionId: "parent", turnId: "parent-turn", toolUseId: "tool-2" },
        child,
        execution(child.sessionId, child.turnId),
      ),
    ).toThrow(/already exists for child/);
  });

  it("starts empty after process-local registry recreation", () => {
    const registry = createActiveSubagentRegistry();
    const parent = { sessionId: "parent", turnId: "parent-turn", toolUseId: "tool-1" };
    const child = { sessionId: "child", turnId: "child-turn" };
    registry.register(parent, child, execution(child.sessionId, child.turnId));

    const restarted = createActiveSubagentRegistry();
    expect(restarted.getLinkByParent(parent)).toBeUndefined();
    expect(restarted.getLinkByChild(child)).toBeUndefined();
  });
});
