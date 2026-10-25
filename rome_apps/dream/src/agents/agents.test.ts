import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

function agent(file: string): { tools: string[]; actions: string[] } {
  return parse(readFileSync(join(here, file), "utf8"));
}

// Chats on Rome's accounts are other people's words and can carry a prompt
// injection. The tool and action lists are what core enforces (it ignores
// permissionMode), so the agent that reads those chats can only work with
// memory. The agent that runs code is not given them: no reader for them, and
// no memory path. With Bash it could still reach them on disk, so that half
// rests on its inputs and prompt, not on enforcement.
describe("dream agents", () => {
  it("keeps the agent that reads Rome's account chats to file tools", () => {
    const memory = agent("dream.yaml");
    expect(memory.actions).toContain("get_account_chats");
    // No builtin tool: core confines none of them, and on Codex any file tool
    // brings a full shell. It works with memory through actions that refuse any
    // path outside the memory directory.
    expect(memory.tools).toEqual([]);
    expect(memory.actions).toEqual([
      "get_webchat_conversations",
      "get_account_chats",
      "get_action_logs",
      "search_chats",
      "list_memory_files",
      "read_memory_file",
      "write_memory_file",
      "edit_memory_file",
    ]);
  });

  it("never gives the agent that runs code Rome's account chats", () => {
    expect(agent("dream-practice.yaml").actions).not.toContain("get_account_chats");
  });
});
