import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "./registry.js";
import { validateGlobalActions } from "./global-actions.js";
import type { Action } from "./types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";

function namespacedRegistry(): ActionRegistryImpl {
  return new ActionRegistryImpl([], { legacyBindings: createEmptyLegacyArtifactBindings() });
}

function appMetadata(appId: string, name: string): ArtifactMetadata {
  return {
    kind: "action",
    ownerType: "app",
    ownerId: appId,
    publicName: name,
    aliases: [],
    sourcePath: `/apps/${appId}/actions/${name}`,
  };
}

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

describe("validateGlobalActions", () => {
  it("passes when the ref resolves to an agent-callable action owned by the declared app", () => {
    const registry = namespacedRegistry();
    registry.register(callableAction("ask_question"), appMetadata("ask-user", "ask_question"));

    expect(() =>
      validateGlobalActions(registry, [{ appId: "ask-user", actionName: "ask_question" }]),
    ).not.toThrow();
  });

  it("throws when the named action is not registered", () => {
    const registry = namespacedRegistry();

    expect(() =>
      validateGlobalActions(registry, [{ appId: "ask-user", actionName: "ask_question" }]),
    ).toThrow(/no action named "ask_question" is registered/);
  });

  it("does not resolve a same-local-name action from a different app", () => {
    const registry = namespacedRegistry();
    registry.register(callableAction("ask_question"), appMetadata("imposter", "ask_question"));

    expect(() =>
      validateGlobalActions(registry, [{ appId: "ask-user", actionName: "ask_question" }]),
    ).toThrow(/no action named "ask_question" is registered/);
  });

  it("throws when the action is not agent-callable", () => {
    const registry = namespacedRegistry();
    const eventOnly: Action = {
      config: {
        name: "ask_question",
        type: "system",
        description: "event only",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "write",
      },
      execute: async () => ({ status: "ok" }),
    };
    registry.register(eventOnly, appMetadata("ask-user", "ask_question"));

    expect(() =>
      validateGlobalActions(registry, [{ appId: "ask-user", actionName: "ask_question" }]),
    ).toThrow(/not agent-callable/);
  });
});
