// Calling the Rome tools the way a provider does, for tests that drive a mock
// model. A real adapter relays `execute_action`'s text back to the model; these
// helpers parse it so a test can assert on the action's own output, and raise
// the error text the model would have read.

import type { ModelToolCallContext, RomeToolResult, RomeTools } from "../agent/index.js";
import { createRomeTools } from "../core/mcp/server.js";

/** Rome tools serving no actions, skills or subagents. */
export function noRomeTools(): RomeTools {
  return createRomeTools({
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "delegated",
  });
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
