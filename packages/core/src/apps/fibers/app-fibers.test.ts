import { afterEach, describe, expect, it } from "@rstest/core";
import type { Skill } from "../../agent/index.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import type { Action } from "../actions/types.js";
import { createEmptyLegacyArtifactBindings } from "../artifact-id.js";
import { SkillLoader } from "../skill-loader.js";
import type { ArtifactMetadata } from "../types.js";
import { AgentLoader, type LoadedAgent } from "../agent-loader.js";
import { AppFibers, addActions, addEntries, addSkills } from "./app-fibers.js";

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

async function start(
  fibers: AppFibers,
  appId: string,
  actions: string[],
  skills: string[],
  version = "1",
): Promise<void> {
  await fibers.contribute(
    appId,
    "actions",
    addActions(
      actions.map((name) => ({ action: action(name, version), metadata: metadata(appId, name) })),
    ),
  );
  await fibers.contribute(appId, "skills", addSkills(skills.map((name) => skill(appId, name))));
}

describe("AppFibers", () => {
  const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
  let fibers: AppFibers;
  afterEach(async () => {
    await fibers?.close();
  });

  function setup() {
    const actions = new ActionRegistryImpl(identity);
    const skills = new SkillLoader(identity);
    fibers = new AppFibers({ actions, skills });
    return { actions, skills };
  }

  it("registers an app's actions and skills when it starts", async () => {
    const { actions, skills } = setup();
    await start(fibers, "dream", ["dream", "skill_review"], ["memory"]);

    expect(actions.list().sort()).toEqual(["dream:dream", "dream:skill_review"]);
    expect(skills.list().map((s) => s.name)).toEqual(["dream:memory"]);
    expect(fibers.heldBy("dream")).toEqual([
      "actions:dream",
      "actions:skill_review",
      "skills:dream:memory",
    ]);
  });

  it("uninstall removes that app's entries and leaves other apps alone", async () => {
    const { actions, skills } = setup();
    await start(fibers, "dream", ["dream"], ["memory"]);
    await start(fibers, "inbox", ["message_handler"], ["triage"]);

    await fibers.stop("dream");

    expect(actions.list()).toEqual(["inbox:message_handler"]);
    expect(skills.list().map((s) => s.name)).toEqual(["inbox:triage"]);
    expect(fibers.heldBy("dream")).toEqual([]);
  });

  it("upgrade replaces the old version's entries with the new version's", async () => {
    const { actions, skills } = setup();
    await start(fibers, "dream", ["dream", "old_action"], ["memory"], "1");

    await start(fibers, "dream", ["dream", "new_action"], ["memory"], "2");

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
    fibers = new AppFibers({ actions: tracking("action"), skills: tracking("skill") });
    await start(fibers, "dream", ["a", "b"], ["c"]);

    await fibers.stop("dream");

    expect(order).toEqual(["skill:dream:c", "action:b", "action:a"]);
  });

  it("an undo left over from an older registration does not remove a newer one", () => {
    const actions = new ActionRegistryImpl(identity);
    const undoOld = actions.add(action("dream", "1"), metadata("dream", "dream"));
    actions.add(action("dream", "2"), metadata("dream", "dream"));

    undoOld();

    expect(actions.get("dream:dream")?.config.description).toBe("dream v2");
  });

  it("the main agent gains an app's agent as a subagent while that app is installed", async () => {
    const agents = new AgentLoader(identity);
    fibers = new AppFibers({ agents });
    const main = loadedAgent("core", "main", ["coding:coding"]);
    agents.add(main);
    expect(agents.find("main")?.definition.allowedSubagents).toEqual([]);

    await fibers.contribute(
      "coding",
      "agents",
      addEntries("agents", [loadedAgent("coding", "coding")], (entry) => entry.agent.name),
    );
    expect(agents.find("main")?.definition.allowedSubagents).toEqual(["coding:coding"]);

    await fibers.stop("coding");
    expect(agents.find("coding:coding")).toBeUndefined();
    expect(agents.find("main")?.definition.allowedSubagents).toEqual([]);
  });

  it("an app agent naming a missing subagent waits until that agent is installed", async () => {
    const agents = new AgentLoader(identity);
    fibers = new AppFibers({ agents });
    await fibers.contribute(
      "briefing",
      "agents",
      addEntries(
        "agents",
        [loadedAgent("briefing", "writer", ["coding:coding"])],
        (entry) => entry.agent.name,
      ),
    );
    expect(agents.find("briefing:writer")).toBeUndefined();
    expect(agents.getRegistryLoadFailures().map((failure) => failure.ownerId)).toEqual([
      "briefing",
    ]);

    await fibers.contribute(
      "coding",
      "agents",
      addEntries("agents", [loadedAgent("coding", "coding")], (entry) => entry.agent.name),
    );
    expect(agents.find("briefing:writer")?.definition.allowedSubagents).toEqual(["coding:coding"]);
    expect(agents.getRegistryLoadFailures()).toEqual([]);
  });
});

function loadedAgent(ownerId: string, localName: string, allowedSubagents?: string[]): LoadedAgent {
  const name = ownerId === "core" ? localName : `${ownerId}:${localName}`;
  const ownerType = ownerId === "core" ? ("core" as const) : ("app" as const);
  return {
    agent: {
      name,
      localName,
      ownerType,
      ownerId,
      definition: {
        description: localName,
        reasoningEffort: "high",
        systemPromptPrefix: "",
        tools: [],
        permissionMode: "default",
        ...(allowedSubagents ? { allowedSubagents } : {}),
      },
    },
    metadata: {
      kind: "agent",
      ownerType,
      ownerId,
      publicName: localName,
      aliases: [],
      sourcePath: "",
    },
  };
}
