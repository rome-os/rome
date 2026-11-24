import { createHash } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import { setupFingerprint, type SessionSetup } from "./session-setup.js";

const baseSetup: SessionSetup = {
  systemPrompt: "You are concierge.",
  builtinTools: ["Read", "Bash"],
  mcpServers: [],
  outputSchema: null,
  tools: {
    actions: [
      {
        name: "execute_action",
        description: "Run an action",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    subagents: [],
    skills: [],
    ask_user: [],
    computer: [],
  },
};

describe("setupFingerprint", () => {
  it("matches the pre-computer-use canonical fingerprint when the computer group is empty", () => {
    const legacyCanonical = JSON.stringify([
      baseSetup.systemPrompt,
      [...baseSetup.builtinTools],
      [...baseSetup.mcpServers],
      baseSetup.outputSchema,
      [
        [
          "actions",
          baseSetup.tools.actions.map(({ name, description, inputSchema }) => [
            name,
            description,
            inputSchema,
          ]),
        ],
        ["subagents", []],
        ["skills", []],
        ["ask_user", []],
      ],
    ]);
    const expected = createHash("sha256").update(legacyCanonical).digest("hex");

    expect(setupFingerprint(baseSetup)).toBe(expected);
  });

  it("changes when computer tools are mounted or modified", () => {
    const idle = setupFingerprint(baseSetup);
    const active = setupFingerprint({
      ...baseSetup,
      tools: {
        ...baseSetup.tools,
        computer: [
          {
            name: "computer_status",
            description: "Inspect status",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    const updated = setupFingerprint({
      ...baseSetup,
      tools: {
        ...baseSetup.tools,
        computer: [
          {
            name: "computer_status",
            description: "Inspect status v2",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });

    expect(active).not.toBe(idle);
    expect(updated).not.toBe(active);
  });
});
