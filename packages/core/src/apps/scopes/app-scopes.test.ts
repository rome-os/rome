import { afterEach, describe, expect, it } from "@rstest/core";
import type { Skill } from "../../agent/index.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import type { Action } from "../actions/types.js";
import { createEmptyLegacyArtifactBindings } from "../artifact-id.js";
import { SkillLoader } from "../skill-loader.js";
import type { ArtifactMetadata } from "../types.js";
import { AppScopes, type AppContribution } from "./app-scopes.js";

function action(name: string, version = "1"): Action {
  return {
    config: {
      name,
      type: "custom",
      description: `${name} v${version}`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: { type: "object" },
    execute: async () => ({ status: "ok" }),
  };
}

function metadata(appId: string, name: string): ArtifactMetadata {
  return {
    kind: "action",
    ownerType: "app",
    ownerId: appId,
    publicName: name,
    aliases: [],
    sourcePath: "",
  };
}

function skill(appId: string, name: string): Skill {
  return {
    name: `${appId}:${name}`,
    localName: name,
    description: name,
    content: name,
    ownerType: "app",
    ownerId: appId,
  };
}

function app(appId: string, actions: string[], skills: string[], version = "1"): AppContribution {
  return {
    appId,
    actions: actions.map((name) => ({
      action: action(name, version),
      metadata: metadata(appId, name),
    })),
    skills: skills.map((name) => skill(appId, name)),
  };
}

describe("AppScopes", () => {
  const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
  let scopes: AppScopes;
  afterEach(async () => {
    await scopes?.close();
  });

  function setup() {
    const actions = new ActionRegistryImpl(identity);
    const skills = new SkillLoader(identity);
    scopes = new AppScopes({ actions, skills });
    return { actions, skills };
  }

  it("registers an app's actions and skills when it starts", async () => {
    const { actions, skills } = setup();
    await scopes.start(app("dream", ["dream", "skill_review"], ["memory"]));

    expect(actions.list().sort()).toEqual(["dream:dream", "dream:skill_review"]);
    expect(skills.list().map((s) => s.name)).toEqual(["dream:memory"]);
    expect(scopes.heldBy("dream")).toEqual([
      "action:dream",
      "action:skill_review",
      "skill:dream:memory",
    ]);
  });

  it("uninstall removes that app's entries and leaves other apps alone", async () => {
    const { actions, skills } = setup();
    await scopes.start(app("dream", ["dream"], ["memory"]));
    await scopes.start(app("inbox", ["message_handler"], ["triage"]));

    await scopes.stop("dream");

    expect(actions.list()).toEqual(["inbox:message_handler"]);
    expect(skills.list().map((s) => s.name)).toEqual(["inbox:triage"]);
    expect(scopes.heldBy("dream")).toEqual([]);
  });

  it("upgrade replaces the old version's entries with the new version's", async () => {
    const { actions, skills } = setup();
    await scopes.start(app("dream", ["dream", "old_action"], ["memory"], "1"));

    await scopes.start(app("dream", ["dream", "new_action"], ["memory"], "2"));

    expect(actions.list().sort()).toEqual(["dream:dream", "dream:new_action"]);
    expect(actions.get("dream:dream")?.config.description).toBe("dream v2");
    expect(skills.list().map((s) => s.name)).toEqual(["dream:memory"]);
  });

  it("disposes in reverse order of registration", async () => {
    const order: string[] = [];
    const tracking = (kind: string) => ({
      add(entry: { config?: { name: string }; name?: string }) {
        const name = entry.config?.name ?? entry.name;
        return () => order.push(`${kind}:${name}`);
      },
    });
    scopes = new AppScopes({ actions: tracking("action"), skills: tracking("skill") });
    await scopes.start(app("dream", ["a", "b"], ["c"]));

    await scopes.stop("dream");

    expect(order).toEqual(["skill:dream:c", "action:b", "action:a"]);
  });

  it("an undo left over from an older registration does not remove a newer one", () => {
    const actions = new ActionRegistryImpl(identity);
    const undoOld = actions.add(action("dream", "1"), metadata("dream", "dream"));
    actions.add(action("dream", "2"), metadata("dream", "dream"));

    undoOld();

    expect(actions.get("dream:dream")?.config.description).toBe("dream v2");
  });
});
