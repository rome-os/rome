import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@rstest/core";
import { buildAnthropicMcpServers } from "./anthropic-mcp-servers.js";
import { AnthropicProvider, CLAUDE_AGENT_SDK_ENV } from "./anthropic-provider.js";
import { createRomeMcpServer, type RomeMcpGroup } from "./mcp/server.js";
import { WEBCHAT_LARGE_MODEL_SELECTIONS } from "./model-selector.js";

// Every Rome MCP group, so a group the builder stops registering still counts.
const ROME_MCP_GROUPS: readonly RomeMcpGroup[] = [
  "actions",
  "subagents",
  "skills",
  "output",
  "ask_user",
];

const claudeModels = Object.values(WEBCHAT_LARGE_MODEL_SELECTIONS)
  .filter((selection) => selection.providerId === "anthropic")
  .map((selection) => selection.model);

/**
 * Smoke the bundled Claude Code CLI, not a mocked SDK. A CLI upgrade can drop a
 * builtin tool or Rome's own MCP tools without any error (#629 lost TodoWrite
 * this way). The CLI reports the agent's tools in its init message, before it
 * calls the model API, so no network or mock server is needed.
 */
describe("bundled Claude Code", () => {
  const builtinTools = [...new AnthropicProvider().builtinTools];
  // A web chat's Rome tools: actions, skills and the interactive ones.
  const facade = {
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "unused",
    supportsInteractiveSurface: true,
  };

  it.each(claudeModels)("gives %s every tool Rome requests", async (model) => {
    // SDK MCP servers hold one connection each, so build them per query.
    const mcpServers = buildAnthropicMcpServers(facade);
    const romeServer = createRomeMcpServer(facade);
    const romeTools = ROME_MCP_GROUPS.flatMap((group) =>
      romeServer.listTools(group).map((tool) => `mcp__${group}__${tool.name}`),
    );
    const home = await mkdtemp(join(tmpdir(), "rome-claude-tools-"));
    const abortController = new AbortController();
    const q = query({
      // The CLI sends its init message once the first input arrives.
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: "hi" },
          parent_tool_use_id: null,
          session_id: "",
        };
        await new Promise<void>((resolve) =>
          abortController.signal.addEventListener("abort", () => resolve()),
        );
      })(),
      options: {
        abortController,
        model,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "",
          ANTHROPIC_API_KEY: "sk-ant-test",
          // Nothing listens here; the init message comes before any API call.
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ...CLAUDE_AGENT_SDK_ENV,
        },
        tools: builtinTools,
        mcpServers,
        strictMcpConfig: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        cwd: home,
      },
    });
    try {
      for await (const message of q) {
        if (message.type !== "system" || message.subtype !== "init") continue;
        const missing = [...builtinTools, ...romeTools].filter(
          (tool) => !message.tools.includes(tool),
        );
        expect(
          missing,
          `Claude Code ${message.claude_code_version} dropped tools for ${model}`,
        ).toEqual([]);
        return;
      }
      throw new Error("Claude Code exited before its init message");
    } finally {
      abortController.abort();
      q.close();
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 30_000);
});
