import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { ROME_TOOL_GROUPS, type ModelSessionParams } from "../agent/index.js";
import { getCoreRoot, getProfileDir, getProfileMemoryDir, getProjectRoot } from "../paths.js";
import { buildAgentConfig } from "./helpers.js";
import { createTestRome, type TestRome } from "./kit/index.js";

// Pins, byte for byte, what a model reads when a session opens: the system
// prompt and every Rome tool. The stored snapshot is the gate for moving this
// code: a refactor leaves it unchanged, and a change to it is a change to what
// the model sees.

function seedPromptFiles(): void {
  writeFileSync(join(getCoreRoot(), "CHARTER.md"), "Charter text.\n");
  mkdirSync(join(getProfileMemoryDir(), "projects", "garden"), { recursive: true });
  writeFileSync(join(getProfileMemoryDir(), "IDENTITY.md"), "Identity text.\n");
  writeFileSync(join(getProfileMemoryDir(), "MEMORY.md"), "Memory index.\n");
  writeFileSync(
    join(getProfileMemoryDir(), "projects", "garden", "PROJECT.md"),
    "# Garden\n\nFirst paragraph of the garden.\n\nSecond paragraph.\n",
  );
}

/** The session as the model reads it, with the sandbox's random paths masked. */
function readByModel(session: ModelSessionParams | undefined) {
  if (!session) throw new Error("no model session opened");
  const mask = (text: string) =>
    text.split(getProfileDir()).join("<profile>").split(getProjectRoot()).join("<root>");
  return {
    systemPrompt: mask(session.config.systemPrompt),
    tools: Object.fromEntries(
      ROME_TOOL_GROUPS.map((group) => [
        group,
        JSON.parse(mask(JSON.stringify(session.tools.listTools(group)))),
      ]),
    ),
  };
}

const mainAgent = buildAgentConfig({
  name: "main",
  systemPromptPrefix: "You are the main agent.",
  actions: ["*"],
});

describe("what the model reads when a session opens", () => {
  let rome: TestRome | undefined;

  afterEach(async () => {
    rs.restoreAllMocks();
    rs.unstubAllEnvs();
    await rome?.cleanup();
    rome = undefined;
  });

  async function start(agents = [mainAgent]): Promise<TestRome> {
    rs.stubEnv("INTERNAL_API_PORT", "4141");
    rome = await createTestRome({ agents, repoView: "empty" });
    seedPromptFiles();
    return rome;
  }

  it("a core agent in a chat that draws cards, with a context suffix", async () => {
    const rome = await start();
    await rome.runAgent({
      prompt: "Hello",
      contextSuffix: "Context suffix.",
      channelThreadKey: "webchat:pin-chat",
      threadContext: { channel: "webchat", threadId: "pin-chat" },
    });
    expect(readByModel(rome.model.sessions[0])).toMatchSnapshot();
  });

  it("a core agent in a chat that draws plain text", async () => {
    const rome = await start();
    await rome.runAgent({
      prompt: "Hello",
      channelThreadKey: "telegram:pin-chat",
      threadContext: { channel: "telegram", threadId: "pin-chat" },
    });
    expect(readByModel(rome.model.sessions[0])).toMatchSnapshot();
  });

  it("a core agent that loads no memory", async () => {
    const rome = await start([
      buildAgentConfig({ name: "helper", systemPromptPrefix: "You are a helper." }),
    ]);
    await rome.runAgent({ agentName: "helper", prompt: "Hello" });
    expect(readByModel(rome.model.sessions[0])).toMatchSnapshot();
  });

  it("a core agent that may delegate to a subagent", async () => {
    const rome = await start([
      { ...mainAgent, allowedSubagents: ["core:helper"] },
      buildAgentConfig({
        name: "helper",
        description: "Helps with one task.",
        systemPromptPrefix: "You are a helper.",
      }),
    ]);
    await rome.runAgent({ prompt: "Hello" });
    expect(readByModel(rome.model.sessions[0])).toMatchSnapshot();
  });

  it("an app's agent", async () => {
    const rome = await start();
    const getRecord = rome.agentLoader.getRecord.bind(rome.agentLoader);
    rs.spyOn(rome.agentLoader, "getRecord").mockImplementation((name) => {
      const record = getRecord(name);
      return {
        ...record,
        metadata: { ...record.metadata, ownerType: "app", ownerId: "pin-app" },
      };
    });
    await rome.runAgent({
      prompt: "Hello",
      contextSuffix: "Context suffix.",
      channelThreadKey: "webchat:pin-chat",
      threadContext: { channel: "webchat", threadId: "pin-chat" },
    });
    expect(readByModel(rome.model.sessions[0])).toMatchSnapshot();
  });
});
