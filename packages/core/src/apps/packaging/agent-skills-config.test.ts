import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { AgentConfigSchema } from "./artifact-config.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const base = {
  name: "triage",
  description: "An untrusted-input classifier",
  systemPromptPrefix: "Classify the message.",
  tools: [],
  permissionMode: "default",
  tier: "small",
};

describe("skills in an agent's config", () => {
  it("leaves skills unset when omitted", () => {
    expect(AgentConfigSchema.parse(base).skills).toBeUndefined();
  });

  it.each([false, true])("accepts skills: %s", (skills) => {
    expect(AgentConfigSchema.parse({ ...base, skills }).skills).toBe(skills);
  });

  it.each([
    { skills: [] },
    { skills: ["notes:filing"] },
    { skills: "none" },
    { skills: null },
  ])("rejects non-boolean skills $skills", ({ skills }) => {
    expect(AgentConfigSchema.safeParse({ ...base, skills }).success).toBe(false);
  });

  it.each([
    "packages/core/agents/concierge-triage.yaml",
    "rome_apps/inbox/src/agents/sentinel.yaml",
  ])("%s parses with skills: false", async (relativePath) => {
    const raw = parseYaml(await readFile(join(REPO, relativePath), "utf-8"));
    const config = AgentConfigSchema.parse(raw);
    expect(config.skills).toBe(false);
  });
});
