import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

function agent(file: string): { tools: string[]; actions: string[]; permissionMode: string } {
  return parse(readFileSync(join(here, file), "utf8"));
}

// Text other people wrote on Rome's accounts can carry a prompt injection, so
// the agent that reads it holds file tools only, and the agent that can run
// code never reads it.
describe("dream agents", () => {
  it("keeps the agent that reads Rome's account chats to file tools", () => {
    const memory = agent("dream.yaml");
    expect(memory.actions).toContain("get_account_chats");
    expect(memory.tools).not.toContain("Bash");
    expect(memory.permissionMode).toBe("acceptEdits");
    expect(memory.actions).toEqual([
      "get_webchat_conversations",
      "get_account_chats",
      "get_action_logs",
    ]);
  });

  it("never gives the agent that runs code Rome's account chats", () => {
    expect(agent("dream-practice.yaml").actions).not.toContain("get_account_chats");
  });
});
