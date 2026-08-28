import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { z } from "zod";
import { buildAnthropicMcpServers } from "./anthropic-mcp-servers.js";
import type {
  ActionMcpDefinition,
  ModelToolCallContext,
  ModelToolDefinition,
  SkillMcpDefinition,
} from "./agent-runner.js";

const { createSdkMcpServerMock, sdkToolMock } = rs.hoisted(() => ({
  createSdkMcpServerMock: rs.fn((config: unknown) => config),
  sdkToolMock: rs.fn(
    (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
    ) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  ),
}));

rs.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: createSdkMcpServerMock,
  tool: sdkToolMock,
}));

interface BuildArgs {
  actionCatalog?: ActionMcpDefinition[];
  getActionCatalog?: () => ActionMcpDefinition[];
  skillCatalog?: SkillMcpDefinition[];
  getSkillCatalog?: () => SkillMcpDefinition[];
  subagentTools?: ModelToolDefinition[];
  executeAction?: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent?: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
}

const baseActionCatalog: ActionMcpDefinition[] = [
  {
    name: "demo_action",
    description: "Schedule a calendar event",
    type: "system",
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: "write",
    requiresApproval: false,
    cancellable: false,
    inputSchema: {
      properties: {
        title: { type: "string", description: "Event title" },
        timezone: { type: "string", description: "IANA timezone for the event" },
      },
      required: ["title"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a user",
    type: "system",
    complexity: "moderate",
    speed: "fast",
    reliability: "high",
    sideEffects: "write",
    requiresApproval: true,
    cancellable: true,
    inputSchema: {
      properties: {
        recipient: { type: "string", description: "Destination user or thread" },
        text: { type: "string", description: "Message body text" },
      },
      required: ["recipient", "text"],
    },
  },
];

function build(args: BuildArgs = {}) {
  // The production type requires `getActionCatalog` + `getSkillCatalog`; the
  // test helper still accepts the convenient static `actionCatalog` /
  // `skillCatalog` inputs and synthesizes the getters here.
  const actionSnapshot = args.actionCatalog ?? baseActionCatalog;
  const skillSnapshot = args.skillCatalog ?? [];
  return buildAnthropicMcpServers({
    getActionCatalog: args.getActionCatalog ?? (() => actionSnapshot),
    getSkillCatalog: args.getSkillCatalog ?? (() => skillSnapshot),
    subagentTools: args.subagentTools ?? [],
    executeAction: args.executeAction ?? (async () => ({ ok: true })),
    executeSubagent: args.executeSubagent ?? (async () => "delegated"),
  });
}

function getActionsServerTools() {
  const serverConfig = createSdkMcpServerMock.mock.calls.find(
    ([config]) => (config as { name: string }).name === "actions",
  )?.[0] as {
    tools: Array<{
      name: string;
      inputSchema: Record<string, z.ZodType>;
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
      }>;
    }>;
  };
  return serverConfig.tools;
}

function getSkillsServerTools() {
  const serverConfig = createSdkMcpServerMock.mock.calls.find(
    ([config]) => (config as { name: string }).name === "skills",
  )?.[0] as
    | {
        tools: Array<{
          name: string;
          inputSchema: Record<string, z.ZodType>;
          handler: (args: Record<string, unknown>) => Promise<{
            content: Array<{ text: string }>;
            isError?: boolean;
          }>;
        }>;
      }
    | undefined;
  return serverConfig?.tools ?? [];
}

function getSubagentServerTools() {
  const serverConfig = createSdkMcpServerMock.mock.calls.find(
    ([config]) => (config as { name: string }).name === "subagents",
  )?.[0] as
    | {
        tools: Array<{
          name: string;
          handler: (
            args: Record<string, unknown>,
            extra?: unknown,
          ) => Promise<{
            content: Array<{ text: string }>;
            isError?: boolean;
          }>;
        }>;
      }
    | undefined;
  return serverConfig?.tools ?? [];
}

describe("buildAnthropicMcpServers", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("registers only the fixed four tools on the actions MCP server", () => {
    build();
    const tools = getActionsServerTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_actions",
      "read_action",
      "search_actions",
      "execute_action",
    ]);
  });

  it("registers only the fixed three tools on the skills MCP server", () => {
    build();
    const tools = getSkillsServerTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_skills", "search_skills", "read_skill"]);
  });

  it("recommends the valid default limit on action and skill search tools", () => {
    build();

    for (const searchTool of [
      getActionsServerTools().find((tool) => tool.name === "search_actions"),
      getSkillsServerTools().find((tool) => tool.name === "search_skills"),
    ]) {
      const advertisedSchema = z.toJSONSchema(z.object(searchTool!.inputSchema));
      expect(advertisedSchema).toMatchObject({
        properties: {
          limit: {
            description:
              "Optional. Recommended: omit this parameter to use the default of 10. " +
              "If provided, use an integer from 1 to 25.",
          },
        },
      });
    }
  });

  it("passes Claude's exact tool-use identity into subagent execution", async () => {
    const executeSubagent = rs.fn(async () => ({ status: "completed" }));
    build({
      subagentTools: [
        {
          name: "researcher",
          description: "Research a topic",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
          },
        },
      ],
      executeSubagent,
    });
    const tool = getSubagentServerTools().find((candidate) => candidate.name === "researcher");

    const response = await tool!.handler(
      { prompt: "inspect" },
      { _meta: { "claudecode/toolUseId": "toolu_child_1" } },
    );

    expect(response.isError).toBeUndefined();
    expect(executeSubagent).toHaveBeenCalledWith(
      "researcher",
      { prompt: "inspect" },
      { toolUseId: "toolu_child_1" },
    );
  });

  it("lists only allowed actions", async () => {
    build();
    const listTool = getActionsServerTools().find((tool) => tool.name === "list_actions");
    const response = await listTool!.handler({});
    const payload = JSON.parse(response.content[0].text) as Array<Record<string, unknown>>;
    expect(payload.map((item) => item.name)).toEqual(["demo_action", "send_message"]);
    expect(payload[0]).not.toHaveProperty("inputSchema");
  });

  it("reads arguments without exposing raw inputSchema", async () => {
    build();
    const readTool = getActionsServerTools().find((tool) => tool.name === "read_action");
    const response = await readTool!.handler({ action_name: "demo_action" });
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: "demo_action",
      description: "Schedule a calendar event",
    });
    expect(payload).not.toHaveProperty("inputSchema");
    expect(payload.arguments).toEqual([
      { description: "Event title", name: "title", required: true, type: "string" },
      {
        description: "IANA timezone for the event",
        name: "timezone",
        required: false,
        type: "string",
      },
    ]);
  });

  it("adds explicit JSON-number guidance for numeric action arguments", async () => {
    build({
      actionCatalog: [
        {
          name: "list_items",
          description: "List items with pagination",
          type: "system",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "read-only",
          requiresApproval: false,
          cancellable: false,
          inputSchema: {
            properties: {
              limit: { type: "integer", description: "Maximum rows to return" },
              offset: { type: "number", description: "Rows to skip" },
              cursor: { type: "string", description: "Opaque page cursor" },
            },
          },
        },
      ],
    });
    const readTool = getActionsServerTools().find((tool) => tool.name === "read_action");
    const response = await readTool!.handler({ action_name: "list_items" });
    const payload = JSON.parse(response.content[0].text) as {
      arguments: Array<Record<string, unknown>>;
    };

    expect(payload.arguments).toEqual([
      {
        description: "Maximum rows to return",
        guidance:
          'Pass this value as a JSON integer, e.g. 10. Do not pass it as a string like "10".',
        name: "limit",
        required: false,
        type: "integer",
      },
      {
        description: "Rows to skip",
        guidance:
          'Pass this value as a JSON number, e.g. 10. Do not pass it as a string like "10".',
        name: "offset",
        required: false,
        type: "number",
      },
      {
        description: "Opaque page cursor",
        name: "cursor",
        required: false,
        type: "string",
      },
    ]);
  });

  it("searches by description and argument guidance with a capped limit", async () => {
    build();
    const searchTool = getActionsServerTools().find((tool) => tool.name === "search_actions");
    const response = await searchTool!.handler({ query: "timezone", limit: 99 });
    const payload = JSON.parse(response.content[0].text) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("demo_action");
  });

  it("treats bare action queries as regex by default", async () => {
    build();
    const searchTool = getActionsServerTools().find((tool) => tool.name === "search_actions");
    const response = await searchTool!.handler({ query: "^send_" });
    const payload = JSON.parse(response.content[0].text) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("send_message");
  });

  it("returns a tool error for invalid bare action regex", async () => {
    build();
    const searchTool = getActionsServerTools().find((tool) => tool.name === "search_actions");
    const response = await searchTool!.handler({ query: "[invalid" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Invalid regex query");
  });

  it("still supports slash-delimited action regex with explicit flags", async () => {
    build();
    const searchTool = getActionsServerTools().find((tool) => tool.name === "search_actions");
    const response = await searchTool!.handler({ query: "/SEND_/i" });
    const payload = JSON.parse(response.content[0].text) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("send_message");
  });

  it("executes actions with json_args and rejects invalid inputs", async () => {
    // The facade's execute_action no longer pre-checks against the catalog;
    // it delegates to the AgentSession-supplied executeAction, which is the
    // single source of truth for "is this name visible to this agent". The
    // stub here mirrors that contract: unknown name → throw.
    const allowedNames = new Set(baseActionCatalog.map((a) => a.name));
    const executeAction = rs.fn(async (name: string, input: unknown) => {
      if (!allowedNames.has(name)) throw new Error(`Unknown action: ${name}`);
      return { received: input };
    });
    build({ executeAction });
    const executeTool = getActionsServerTools().find((tool) => tool.name === "execute_action");

    const success = await executeTool!.handler({
      action_name: "send_message",
      json_args: { recipient: "u1", text: "hello" },
    });
    expect(executeAction).toHaveBeenCalledWith("send_message", {
      recipient: "u1",
      text: "hello",
    });
    expect(JSON.parse(success.content[0].text)).toEqual({
      received: { recipient: "u1", text: "hello" },
    });

    const unknown = await executeTool!.handler({
      action_name: "missing_action",
      json_args: {},
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("Unknown action: missing_action");

    const invalidArgs = await executeTool!.handler({
      action_name: "send_message",
      json_args: ["bad"],
    });
    expect(invalidArgs.isError).toBe(true);
    expect(invalidArgs.content[0].text).toContain("execute_action.json_args must be an object");
  });

  it("getActionCatalog: list_actions and execute_action see actions added after the bundle was built", async () => {
    // An app_management install registers a new action mid-session. The MCP bundle
    // is built once at openSession; without the getActionCatalog hook the
    // new action stays invisible. The stub here mirrors AgentSession's
    // contract: the executeAction callback is the gate that rejects names
    // that aren't currently visible.
    const liveCatalog: ActionMcpDefinition[] = [baseActionCatalog[0]];
    const executeAction = rs.fn(async (name: string) => {
      if (!liveCatalog.some((a) => a.name === name)) {
        throw new Error(`Unknown action: ${name}`);
      }
      return { ran: name };
    });
    build({
      actionCatalog: liveCatalog,
      getActionCatalog: () => liveCatalog,
      executeAction,
    });

    const listTool = getActionsServerTools().find((tool) => tool.name === "list_actions")!;
    const executeTool = getActionsServerTools().find((tool) => tool.name === "execute_action")!;

    const beforeList = JSON.parse((await listTool.handler({})).content[0].text) as Array<
      Record<string, unknown>
    >;
    expect(beforeList.map((entry) => entry.name)).toEqual(["demo_action"]);

    const beforeExecute = await executeTool.handler({
      action_name: "send_message",
      json_args: { recipient: "u1", text: "hi" },
    });
    expect(beforeExecute.isError).toBe(true);
    expect(beforeExecute.content[0].text).toContain("Unknown action: send_message");

    // Mutate the underlying catalog after the bundle was constructed — this
    // simulates the in-process ActionRegistry gaining a new app's actions
    // after a successful install.
    liveCatalog.push(baseActionCatalog[1]);

    const afterList = JSON.parse((await listTool.handler({})).content[0].text) as Array<
      Record<string, unknown>
    >;
    expect(afterList.map((entry) => entry.name)).toEqual(["demo_action", "send_message"]);

    const afterExecute = await executeTool.handler({
      action_name: "send_message",
      json_args: { recipient: "u1", text: "hi" },
    });
    expect(afterExecute.isError).toBeUndefined();
    expect(executeAction).toHaveBeenCalledWith("send_message", {
      recipient: "u1",
      text: "hi",
    });
  });

  it("getSkillCatalog: list_skills sees skills added after the bundle was built", async () => {
    // app_management { op: "create" } installs a new app mid-session whose
    // skills land in the SkillCatalog asynchronously via the AppCatalog
    // subscriber. The MCP bundle is built once at openSession; without the
    // getSkillCatalog hook the new skill stays invisible until the next
    // session. This test pins the live-getter contract for skills, mirroring
    // the action-catalog test above.
    const browserResearch: SkillMcpDefinition = {
      name: "browser-research",
      description: "Inspect websites and gather findings",
      tools: ["WebSearch", "WebFetch"],
      content: "# Browser Research",
      ownerType: "core",
      ownerId: "browser-research",
    };
    const calendarHelper: SkillMcpDefinition = {
      name: "calendar-helper",
      description: "Coordinate event planning",
      tools: ["demo_action"],
      content: "# Calendar Helper",
      ownerType: "core",
      ownerId: "calendar-helper",
    };
    const liveSkills: SkillMcpDefinition[] = [browserResearch];
    build({
      skillCatalog: liveSkills,
      getSkillCatalog: () => liveSkills,
    });

    const listTool = getSkillsServerTools().find((tool) => tool.name === "list_skills");
    expect(listTool, "skills MCP server must register list_skills").toBeDefined();
    const readTool = getSkillsServerTools().find((tool) => tool.name === "read_skill")!;

    const beforeList = JSON.parse((await listTool!.handler({})).content[0].text) as Array<
      Record<string, unknown>
    >;
    expect(beforeList.map((entry) => entry.name)).toEqual(["browser-research"]);

    // Mutate the underlying catalog after the bundle was constructed — this
    // simulates AppCatalog firing `add` for a freshly-installed app whose
    // skills the SkillCatalog subscriber has just absorbed.
    liveSkills.push(calendarHelper);

    const afterList = JSON.parse((await listTool!.handler({})).content[0].text) as Array<
      Record<string, unknown>
    >;
    expect(afterList.map((entry) => entry.name)).toEqual(["browser-research", "calendar-helper"]);

    const readResponse = await readTool.handler({ skill_name: "calendar-helper" });
    expect(readResponse.isError).toBeUndefined();
    const readPayload = JSON.parse(readResponse.content[0].text) as Record<string, unknown>;
    expect(readPayload).toMatchObject({
      name: "calendar-helper",
      content: "# Calendar Helper",
    });
  });

  it("getSkillCatalog: skills server is registered even when the initial catalog is empty", async () => {
    // A profile that boots with no apps installed must still expose the
    // skill-discovery tools, so the agent can re-list after `app_management`
    // installs an app and the SkillCatalog refreshes. Without this, the very
    // first install in a new session is undiscoverable until restart.
    const liveSkills: SkillMcpDefinition[] = [];
    build({
      skillCatalog: liveSkills,
      getSkillCatalog: () => liveSkills,
    });

    const listTool = getSkillsServerTools().find((tool) => tool.name === "list_skills");
    expect(
      listTool,
      "skills MCP server must register when getSkillCatalog is provided",
    ).toBeDefined();
  });

  it("treats bare skill queries as regex by default", async () => {
    build({
      skillCatalog: [
        {
          name: "browser-research",
          description: "Inspect websites and gather findings",
          tools: ["WebSearch", "WebFetch"],
          content: "# Browser Research",
          ownerType: "core",
          ownerId: "browser-research",
        },
        {
          name: "calendar-helper",
          description: "Coordinate event planning",
          tools: ["demo_action"],
          content: "# Calendar Helper",
          ownerType: "core",
          ownerId: "calendar-helper",
        },
      ],
    });
    const searchTool = getSkillsServerTools().find((tool) => tool.name === "search_skills");
    const response = await searchTool!.handler({ query: "Web(Fetch|Search)" });
    const payload = JSON.parse(response.content[0].text) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("browser-research");
  });

  it("reads a skill when callers pass query instead of skill_name", async () => {
    build({
      skillCatalog: [
        {
          name: "calendar-helper",
          description: "Coordinate event planning",
          tools: ["demo_action"],
          content: "# Calendar Helper",
          ownerType: "core",
          ownerId: "calendar-helper",
        },
      ],
    });
    const readTool = getSkillsServerTools().find((tool) => tool.name === "read_skill");
    const response = await readTool!.handler({ query: "calendar-helper" });
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: "calendar-helper",
      content: "# Calendar Helper",
    });
  });

  it("returns a tool error for invalid bare skill regex", async () => {
    build({
      skillCatalog: [
        {
          name: "browser-research",
          description: "Inspect websites and gather findings",
          tools: ["WebSearch"],
          content: "# Browser Research",
          ownerType: "core",
          ownerId: "browser-research",
        },
      ],
    });
    const searchTool = getSkillsServerTools().find((tool) => tool.name === "search_skills");
    const response = await searchTool!.handler({ query: "[invalid" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Invalid regex query");
  });
});
