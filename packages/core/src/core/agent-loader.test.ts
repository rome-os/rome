import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import { AgentLoader } from "./agent-loader.js";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AppCatalog } from "../apps/catalog.js";
import { createEmptyLegacyArtifactBindings, formatArtifactId } from "../apps/artifact-id.js";

rs.mock("../apps/core-artifacts.js", () => ({
  listCoreArtifactsByKind: async () => [],
}));

const FIXTURES_DIR = join(import.meta.dirname, "..", "test", "fixtures", "agents");

describe("AgentLoader", () => {
  let loader: AgentLoader;

  beforeEach(() => {
    loader = new AgentLoader();
  });

  it("uses the complete scoped app id as an agent namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rome-scoped-agent-"));
    const agentPath = join(root, "baz.yaml");
    await writeFile(
      agentPath,
      [
        "name: baz",
        "description: Scoped agent fixture.",
        "tier: small",
        "permissionMode: bypassPermissions",
        "tools: []",
        "systemPromptPrefix: Test agent.",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      const namespaced = new AgentLoader({
        legacyBindings: createEmptyLegacyArtifactBindings(),
      });
      const catalog = {
        listArtifacts: () => [
          {
            formatVersion: 2,
            kind: "agent",
            publicName: "baz",
            aliases: [],
            ownerType: "app",
            ownerId: "@foo/bar",
            absolutePath: agentPath,
          },
        ],
      } as unknown as AppCatalog;

      await namespaced.loadFromCatalog(catalog);

      expect(namespaced.has("@foo/bar:baz")).toBe(true);
      expect(namespaced.getRecord("@foo/bar:baz").metadata.ownerId).toBe("@foo/bar");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("loadAll()", () => {
    it("loads all YAML files from a directory", async () => {
      const agents = await loader.loadAll(FIXTURES_DIR);

      expect(agents.size).toBe(7);
      expect(agents.has("test-all-actions")).toBe(true);
      expect(agents.has("test-main")).toBe(true);
      expect(agents.has("test-sentinel")).toBe(true);
      expect(agents.has("test-explore")).toBe(true);
      expect(agents.has("test-structured")).toBe(true);
      expect(agents.has("test-code-backed")).toBe(true);
      expect(agents.has("test-pinned")).toBe(true);
    });

    it("parses outputSchema when declared", async () => {
      const agents = await loader.loadAll(FIXTURES_DIR);
      const structured = agents.get("test-structured")!;
      expect(structured.outputSchema).toBeDefined();
      expect(structured.outputSchema).toMatchObject({
        type: "object",
        required: ["decision", "reason"],
      });

      // Agents without outputSchema get undefined.
      const main = agents.get("test-main")!;
      expect(main.outputSchema).toBeUndefined();
    });

    it("rejects an outputSchema outside the portable-v1 profile during load", async () => {
      const root = await mkdtemp(join(tmpdir(), "rome-invalid-output-schema-"));
      await writeFile(
        join(root, "invalid.yaml"),
        [
          "name: invalid",
          "description: Invalid structured agent.",
          "tier: small",
          "permissionMode: bypassPermissions",
          "tools: []",
          "systemPromptPrefix: Test agent.",
          "outputSchema:",
          "  type: object",
          "  properties:",
          "    value:",
          "      anyOf:",
          "        - { type: string }",
          "        - { type: 'null' }",
          "  required: [value]",
          "  additionalProperties: false",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        await expect(loader.loadAll(root)).rejects.toThrow(/anyOf is not supported by portable-v1/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("rejects outputSchema values that YAML cannot preserve through JSON", async () => {
      const root = await mkdtemp(join(tmpdir(), "rome-non-json-output-schema-"));
      await writeFile(
        join(root, "invalid.yaml"),
        [
          "name: invalid",
          "description: Invalid structured agent.",
          "tier: small",
          "permissionMode: bypassPermissions",
          "tools: []",
          "systemPromptPrefix: Test agent.",
          "outputSchema:",
          "  type: object",
          "  properties:",
          "    value: { type: number, minimum: .inf }",
          "  required: [value]",
          "  additionalProperties: false",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        await expect(loader.loadAll(root)).rejects.toThrow(/minimum.*finite JSON number/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("parses agent name, tier, tools, and permissions", async () => {
      const agents = await loader.loadAll(FIXTURES_DIR);

      const main = agents.get("test-main")!;
      expect(main.name).toBe("test-main");
      expect(main.tier).toBe("large");
      expect(main.reasoningEffort).toBe("high");
      expect(main.tools).toEqual(["Read", "Edit"]);
      expect(main.actions).toEqual(["demo_action"]);
      expect(main.permissionMode).toBe("acceptEdits");
      expect(main.allowedSubagents).toEqual(["test-explore"]);
      expect(main.description).toBe("Test main agent for unit tests.");

      const sentinel = agents.get("test-sentinel")!;
      expect(sentinel.tier).toBe("small");
      expect(sentinel.permissionMode).toBe("bypassPermissions");
      expect(sentinel.tools).toEqual(["Read", "Glob"]);

      const allActions = agents.get("test-all-actions")!;
      expect(allActions.actions).toEqual(["*"]);
      expect(allActions.reasoningEffort).toBe("low");
    });

    it("validates that referenced subagents exist", async () => {
      // The fixtures have valid subagent refs, so loading should succeed
      const agents = await loader.loadAll(FIXTURES_DIR);
      const main = agents.get("test-main")!;
      expect(main.allowedSubagents).toContain("test-explore");
    });

    it("throws on invalid YAML syntax", async () => {
      // Point to a nonexistent dir to verify error
      await expect(loader.loadAll("/nonexistent/path")).rejects.toThrow();
    });

    it("throws when no YAML files are found in directory", async () => {
      // Use a directory without YAML files
      const emptyDir = join(import.meta.dirname);
      await expect(loader.loadAll(emptyDir)).rejects.toThrow(/No YAML files found/);
    });

    it("maps legacy `model: opus|sonnet|haiku` to tier", async () => {
      // test-main, test-sentinel, test-explore use the legacy `model:` field —
      // loader should normalize silently to the corresponding tier.
      const agents = await loader.loadAll(FIXTURES_DIR);

      expect(agents.get("test-main")!.tier).toBe("large");
      expect(agents.get("test-sentinel")!.tier).toBe("small");
      expect(agents.get("test-explore")!.tier).toBe("small");
    });

    it("accepts the new `tier:` field directly", async () => {
      // test-all-actions uses `tier: medium` (the new field) — verify it
      // passes through unchanged.
      const agents = await loader.loadAll(FIXTURES_DIR);
      expect(agents.get("test-all-actions")!.tier).toBe("medium");
    });

    it("maps `provider:` to providerId, absent when unpinned", async () => {
      const agents = await loader.loadAll(FIXTURES_DIR);
      expect(agents.get("test-pinned")!.providerId).toBe("openai");
      expect(agents.get("test-main")!.providerId).toBeUndefined();
    });

    it("stores configs retrievable via get()", async () => {
      await loader.loadAll(FIXTURES_DIR);

      const config = loader.get("test-main");
      expect(config.name).toBe("test-main");
      expect(config.tier).toBe("large");
    });
  });

  describe("get()", () => {
    it("throws for unknown agent name when none loaded", () => {
      expect(() => loader.get("nonexistent")).toThrow(/Agent "nonexistent" not found/);
    });

    it("throws for unknown agent name after loading", async () => {
      await loader.loadAll(FIXTURES_DIR);
      expect(() => loader.get("nonexistent")).toThrow(/Agent "nonexistent" not found/);
    });
  });

  describe("getAll()", () => {
    it("returns a copy of all loaded agents", async () => {
      await loader.loadAll(FIXTURES_DIR);
      const all = loader.getAll();
      expect(all.size).toBe(7);
      // Ensure it's a copy (different Map reference)
      expect(all).not.toBe(loader.getAll());
    });
  });

  it("lists legacy names only while their canonical agent is loaded", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    const namespaced = new AgentLoader({ legacyBindings });
    await namespaced.loadAll(FIXTURES_DIR);
    legacyBindings.agent.orphan = formatArtifactId("missing-app", "reviewer");

    const records = namespaced.getAllResolvableRecords();

    expect(records.get("test-main")).toBe(records.get("core:test-main"));
    expect(records.has("orphan")).toBe(false);
  });
});
