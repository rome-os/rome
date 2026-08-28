import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "./registry.js";
import type { Action } from "./types.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import type { ArtifactMetadata } from "../apps/types.js";

function callableAction(name: string): Action {
  return {
    config: {
      name,
      type: "system",
      description: `${name} action`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: { type: "object" },
    execute: async () => ({ status: "ok" }),
  };
}

function eventOnlyAction(name: string): Action {
  return {
    config: {
      name,
      type: "system",
      description: `${name} action`,
      complexity: "complex",
      speed: "slow",
      reliability: "high",
      sideEffects: "write",
    },
    execute: async () => ({ status: "ok" }),
  };
}

describe("ActionRegistryImpl", () => {
  it("stores app actions by canonical ID while preserving a legacy bare binding", () => {
    const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const registry = new ActionRegistryImpl([], identity);
    const metadata: ArtifactMetadata = {
      kind: "action",
      ownerType: "app",
      ownerId: "legacy-app",
      publicName: "foo",
      aliases: [],
      sourcePath: "/legacy-app/actions/foo",
    };
    registry.register(callableAction("foo"), metadata);

    expect(registry.list()).toEqual(["legacy-app:foo"]);
    expect(registry.get("legacy-app:foo")?.config.name).toBe("legacy-app:foo");
    expect(registry.get("foo")?.config.name).toBe("legacy-app:foo");
    expect(registry.get("self:foo")).toBeUndefined();
  });

  it("allows v2 apps to reuse a local name without creating a bare binding", () => {
    const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const registry = new ActionRegistryImpl([], identity);
    for (const ownerId of ["review-one", "review-two"]) {
      registry.register(callableAction("review"), {
        kind: "action",
        ownerType: "app",
        ownerId,
        formatVersion: 2,
        publicName: "review",
        aliases: [],
        sourcePath: `/${ownerId}/actions/review`,
      });
    }

    expect(registry.list()).toEqual(["review-one:review", "review-two:review"]);
    expect(registry.get("review-one:review")?.config.name).toBe("review-one:review");
    expect(registry.get("review-two:review")?.config.name).toBe("review-two:review");
    expect(registry.get("review")).toBeUndefined();
  });

  it("returns all agent-callable actions when names includes '*'", () => {
    const registry = new ActionRegistryImpl([]);
    registry.register(callableAction("alpha"));
    registry.register(callableAction("beta"));
    registry.register(eventOnlyAction("workflow_only"));

    const actions = registry.getForAgent(["*"]);

    expect(actions.map((action) => action.config.name)).toEqual(["alpha", "beta"]);
  });

  it("grants a globally-granted action to an agent whose allow-list omits it", () => {
    const registry = new ActionRegistryImpl(["ask_question"]);
    registry.register(callableAction("ask_question"));
    registry.register(callableAction("scoped_tool"));
    registry.register(callableAction("secret_tool"));

    const names = registry.getForAgent(["scoped_tool"]).map((a) => a.config.name);

    expect(names).toContain("scoped_tool");
    expect(names).toContain("ask_question");
    expect(names).not.toContain("secret_tool");
  });

  it("grants globally-granted actions even when the allow-list is empty", () => {
    const registry = new ActionRegistryImpl(["ask_question"]);
    registry.register(callableAction("ask_question"));

    expect(registry.getForAgent([]).map((a) => a.config.name)).toEqual(["ask_question"]);
  });

  it("does not grant a globally-granted name that is not agent-callable", () => {
    const registry = new ActionRegistryImpl(["event_global"]);
    registry.register(eventOnlyAction("event_global"));

    expect(registry.getForAgent([])).toEqual([]);
  });
});
