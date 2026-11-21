import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { parse } = requireCore("yaml") as { parse(source: string): unknown };
const CODEX = "@openai/codex";
const SDK = "@anthropic-ai/claude-agent-sdk";
const CLI = "@anthropic-ai/claude-code";

type Manifest = { dependencies: Record<string, string> };
type Update = {
  "package-ecosystem": string;
  directory: string;
  allow: Array<{ "dependency-name": string }>;
  "versioning-strategy": string;
  schedule: { interval: string };
  "insecure-external-code-execution"?: string;
};
export type AgentToolInputs = {
  core: Manifest;
  cli: Manifest;
  lock: { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  docker: string;
  dependabot: { version: number; updates: Update[] };
};

export function checkAgentTools(input: AgentToolInputs): string[] {
  const findings: string[] = [];
  for (const [name, version] of [
    [CODEX, input.core.dependencies[CODEX]],
    [SDK, input.core.dependencies[SDK]],
    [CLI, input.cli.dependencies[CLI]],
  ]) {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version))
      findings.push(name + " must pin a stable version");
  }
  const cliVersion = input.cli.dependencies[CLI];
  if (JSON.stringify(Object.keys(input.cli.dependencies)) !== JSON.stringify([CLI])) {
    findings.push("The image CLI manifest must contain only Claude Code");
  }
  if (
    input.lock.packages[""]?.dependencies?.[CLI] !== cliVersion ||
    input.lock.packages["node_modules/" + CLI]?.version !== cliVersion
  )
    findings.push("Claude Code's manifest and lockfile disagree");
  if (/@(?:openai\/codex|anthropic-ai\/claude-code)@/.test(input.docker)) {
    findings.push("Docker must not duplicate agent tool version pins");
  }
  for (const required of [
    "npm ci --prefix /opt/rome-agent-tools --omit=dev",
    "COPY --from=agent-tools /opt/rome-agent-tools /opt/rome-agent-tools",
    "ln -sf /opt/rome-agent-tools/node_modules/.bin/claude /usr/local/bin/claude",
    "ln -sf /opt/rome/packages/core/node_modules/.bin/codex /usr/local/bin/codex",
  ]) {
    if (!input.docker.includes(required)) findings.push("Docker is missing: " + required);
  }
  const expected = new Map([
    ["/", [CODEX, SDK].sort()],
    ["/scripts/docker/agent-tools", [CLI]],
  ]);
  if (input.dependabot.version !== 2 || input.dependabot.updates.length !== 2) {
    findings.push("Dependabot must define exactly the two reviewed npm scopes");
  }
  for (const update of input.dependabot.updates) {
    const allowed = update.allow?.map((entry) => entry["dependency-name"]).sort();
    if (
      update["package-ecosystem"] !== "npm" ||
      !expected.has(update.directory) ||
      JSON.stringify(allowed) !== JSON.stringify(expected.get(update.directory)) ||
      update["versioning-strategy"] !== "increase" ||
      update.schedule?.interval !== "daily" ||
      update["insecure-external-code-execution"] === "allow"
    )
      findings.push("Dependabot has an unreviewed update scope: " + update.directory);
    expected.delete(update.directory);
  }
  if (expected.size) findings.push("Dependabot is missing an agent tool scope");
  return findings;
}

export function readAgentTools(root: string): AgentToolInputs {
  const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  return {
    core: json("packages/core/package.json"),
    cli: json("scripts/docker/agent-tools/package.json"),
    lock: json("scripts/docker/agent-tools/package-lock.json"),
    docker: readFileSync(path.join(root, "Dockerfile"), "utf8"),
    dependabot: parse(
      readFileSync(path.join(root, ".github/dependabot.yml"), "utf8"),
    ) as AgentToolInputs["dependabot"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkAgentTools(readAgentTools(fileURLToPath(new URL("..", import.meta.url))));
  for (const finding of findings) console.error(finding);
  process.exitCode = findings.length ? 1 : 0;
}
