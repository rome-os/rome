import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "./registry.js";
import type { Action } from "./types.js";
import {
  claimLegacyArtifactName,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
} from "../apps/artifact-id.js";
import type { ArtifactMetadata } from "../apps/types.js";

function callableAction(
  name: string,
  visibility: Action["config"]["visibility"] = "public",
): Action {
  return {
    config: {
      name,
      type: "system",
      description: `${name} action`,
      visibility,
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
  it("stores app actions by canonical ID and resolves a bound legacy bare name", () => {
    const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    claimLegacyArtifactName(
      identity.legacyBindings,
      "action",
      "foo",
      formatArtifactId("legacy-app", "foo"),
    );
    const registry = new ActionRegistryImpl(identity);
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
    const registry = new ActionRegistryImpl(identity);
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
    const registry = new ActionRegistryImpl();
    registry.register(callableAction("alpha"));
    registry.register(callableAction("beta"));
    registry.register(eventOnlyAction("workflow_only"));

    const actions = registry.getForAgent(["*"]);

    expect(actions.map((action) => action.config.name)).toEqual(["alpha", "beta"]);
  });

  it("does not grant an explicit action through '*'", () => {
    const registry = new ActionRegistryImpl();
    registry.register(callableAction("public_tool"));
    registry.register(callableAction("internal_tool", "explicit"));

    expect(registry.getForAgent(["*"]).map((action) => action.config.name)).toEqual([
      "public_tool",
    ]);
  });

  it("grants an explicit action by exact name alongside '*'", () => {
    const registry = new ActionRegistryImpl();
    registry.register(callableAction("public_tool"));
    registry.register(callableAction("internal_tool", "explicit"));

    expect(
      registry.getForAgent(["*", "internal_tool"]).map((action) => action.config.name),
    ).toEqual(["public_tool", "internal_tool"]);
  });
});
