// Calling the Rome tools the way a provider does, for tests that drive a mock
// model. A real adapter relays `execute_action`'s text back to the model; these
// helpers parse it so a test can assert on the action's own output, and raise
// the error text the model would have read.

import {
  createRomeTools,
  type ModelToolCallContext,
  type RomeToolDefinition,
  type RomeToolResult,
  type RomeTools,
  type Subagent,
  type Subagents,
  type TurnFacts,
} from "../agent/index.js";

type RomeToolsOptions = Parameters<typeof createRomeTools>[0];

export interface TestRomeToolsOptions extends Partial<Omit<RomeToolsOptions, "subagents">> {
  subagents?: readonly Subagent[];
  executeSubagent?: Subagents["run"];
}

/** The turn the tools of a test serve: a session with no running turn. */
export const TEST_TURN: TurnFacts = {
  agentName: "core:test-main",
  continuityKey: "test",
  sessionId: "test-session",
  isSubagent: false,
  actions: ["*"],
  widgets: "plain_text",
  turnId: () => undefined,
  threadContext: () => undefined,
  sharedContext: () => undefined,
  pushLevel: () => undefined,
  threadAnchor: () => undefined,
  inTurn: (fn) => fn(),
};

/** Rome tools for a test, serving no actions, skills or subagents unless given. */
export function testRomeTools(options: TestRomeToolsOptions = {}): RomeTools {
  const { subagents = [], executeSubagent, ...rest } = options;
  return createRomeTools({
    turn: TEST_TURN,
    actions: {
      list: () => [],
      permits: () => true,
      run: async () => ({ status: "ok", data: { ok: true } }),
    },
    skills: { list: () => [] },
    subagents: { list: () => subagents, run: executeSubagent ?? (async () => "delegated") },
    widgetsShow: false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...rest,
  });
}

/** Rome tools serving no actions, skills or subagents. */
export function noRomeTools(): RomeTools {
  return testRomeTools();
}

/** A tool's answer as the action or subagent produced it; an error result throws its text. */
export function parseToolText(result: RomeToolResult): unknown {
  return parseToolResult(result);
}

function parseToolResult(result: RomeToolResult): unknown {
  const text = result.content.map((item) => item.text).join("\n");
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Run an action through `execute_action` and return what the action produced. */
export async function executeActionTool(
  tools: RomeTools,
  name: string,
  args: Record<string, unknown> = {},
  context?: ModelToolCallContext,
): Promise<unknown> {
  return parseToolResult(
    await tools.callTool(
      "actions",
      "execute_action",
      { action_name: name, json_args: args },
      context,
    ),
  );
}

/** Delegate to a subagent through its own tool and return what it produced. */
export async function executeSubagentTool(
  tools: RomeTools,
  name: string,
  input: Record<string, unknown>,
  context: ModelToolCallContext,
): Promise<unknown> {
  return parseToolResult(await tools.callTool("subagents", name, input, context));
}

/** The names the model sees in one tool group. */
export function toolNames(
  tools: RomeTools,
  group: Parameters<RomeTools["listTools"]>[0],
): string[] {
  return tools.listTools(group).map((tool) => tool.name);
}

/** The actions `list_actions` shows the model, by name. */
export async function listActionNames(tools: RomeTools): Promise<string[]> {
  const listed = (await parseToolResultOf(tools, "actions", "list_actions")) as Array<{
    name: string;
  }>;
  return listed.map((action) => action.name);
}

async function parseToolResultOf(
  tools: RomeTools,
  group: Parameters<RomeTools["listTools"]>[0],
  name: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  return parseToolResult(await tools.callTool(group, name, input));
}
