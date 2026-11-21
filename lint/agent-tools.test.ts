import { describe, expect, it } from "@rstest/core";
import { checkAgentTools, type AgentToolInputs } from "./agent-tools.js";

function fixture(): AgentToolInputs {
  return {
    core: {
      dependencies: { "@openai/codex": "0.171.0", "@anthropic-ai/claude-agent-sdk": "0.3.293" },
    },
    cli: { dependencies: { "@anthropic-ai/claude-code": "2.1.293" } },
    lock: {
      packages: {
        "": { dependencies: { "@anthropic-ai/claude-code": "2.1.293" } },
        "node_modules/@anthropic-ai/claude-code": { version: "2.1.293" },
      },
    },
    docker: [
      "npm ci --prefix /opt/rome-agent-tools --omit=dev",
      "COPY --from=agent-tools /opt/rome-agent-tools /opt/rome-agent-tools",
      "ln -sf /opt/rome-agent-tools/node_modules/.bin/claude /usr/local/bin/claude",
      "ln -sf /opt/rome/packages/core/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex",
      "codex --version && claude --version",
    ].join("\n"),
    devDocker: [
      "npm ci --prefix /opt/rome-agent-tools --omit=dev",
      "COPY --from=agent-tools /opt/rome-agent-tools /opt/rome-agent-tools",
      "ln -sf /opt/rome-agent-tools/node_modules/.bin/claude /usr/local/bin/claude",
      "ln -sf /workspace/packages/core/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex",
    ].join("\n"),
    dependabot: {
      version: 2,
      updates: [
        {
          "package-ecosystem": "npm",
          directory: "/",
          schedule: { interval: "daily" },
          allow: [
            { "dependency-name": "@openai/codex" },
            { "dependency-name": "@anthropic-ai/claude-agent-sdk" },
          ],
          "versioning-strategy": "increase",
        },
        {
          "package-ecosystem": "npm",
          directory: "/scripts/docker/agent-tools",
          schedule: { interval: "daily" },
          allow: [{ "dependency-name": "@anthropic-ai/claude-code" }],
          "versioning-strategy": "increase",
        },
      ],
    },
  };
}

describe("agent tool update boundaries", () => {
  it("allows independent Claude SDK and CLI versions", () => {
    expect(checkAgentTools(fixture())).toEqual([]);
  });
  it("allows a Codex bump without another Docker pin", () => {
    const input = fixture();
    input.core.dependencies["@openai/codex"] = "0.172.0";
    expect(checkAgentTools(input)).toEqual([]);
  });
  it("rejects Docker RUN pins even when they match today", () => {
    const input = fixture();
    input.docker += "\nRUN npm install -g @openai/codex@0.171.0";
    expect(checkAgentTools(input)).toContain("Docker must not duplicate agent tool version pins");
  });
  it("rejects duplicate pins in the dev image", () => {
    const input = fixture();
    input.devDocker += "\nRUN npm install -g @anthropic-ai/claude-code@2.1.293";
    expect(checkAgentTools(input)).toContain("Docker must not duplicate agent tool version pins");
  });
  it("rejects a link to pnpm's relocatable shell shim", () => {
    const input = fixture();
    input.docker = input.docker.replace("@openai/codex/bin/codex.js", ".bin/codex");
    expect(checkAgentTools(input).length).toBeGreaterThan(0);
  });
  it("requires executable command smoke checks", () => {
    const input = fixture();
    input.docker = input.docker.replace(
      "codex --version && claude --version",
      "test -x /usr/local/bin/codex",
    );
    expect(checkAgentTools(input)).toContain(
      "Production Docker must execute both global agent commands",
    );
  });
  it("rejects a stale standalone CLI lockfile", () => {
    const input = fixture();
    input.cli.dependencies["@anthropic-ai/claude-code"] = "2.1.294";
    expect(checkAgentTools(input)).toContain("Claude Code's manifest and lockfile disagree");
  });
  it("rejects unrelated dependencies and wildcard update rules", () => {
    const input = fixture();
    input.dependabot.updates[0].allow.push({ "dependency-name": "*" });
    expect(checkAgentTools(input)).toContain("Dependabot has an unreviewed update scope: /");
  });
  it("rejects missing Docker links", () => {
    const input = fixture();
    input.docker = "";
    expect(checkAgentTools(input).length).toBeGreaterThan(0);
  });
  it("rejects prerelease and floating versions", () => {
    const input = fixture();
    input.core.dependencies["@openai/codex"] = "^0.171.0";
    input.cli.dependencies["@anthropic-ai/claude-code"] = "2.1.294-beta.1";
    expect(checkAgentTools(input)).toContain("@openai/codex must pin a stable version");
    expect(checkAgentTools(input)).toContain("@anthropic-ai/claude-code must pin a stable version");
  });
});
