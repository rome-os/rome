import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActionLoader } from "./loader.js";

type TestActionConfig = {
  webhook?: boolean;
};

type ActionLoaderPrivate = {
  readActionConfig(yamlPath: string): Promise<TestActionConfig>;
};

describe("ActionLoader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeActionYaml(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "rome-action-loader-"));
    tempDirs.push(dir);
    const yamlPath = join(dir, "action.yaml");
    writeFileSync(yamlPath, contents, "utf-8");
    return yamlPath;
  }

  it("parses optional webhook boolean from action.yaml", async () => {
    const yamlPath = writeActionYaml(
      [
        "name: send_message",
        "type: system",
        "description: Send a message",
        "complexity: simple",
        "speed: fast",
        "reliability: high",
        "sideEffects: write",
        "webhook: true",
      ].join("\n"),
    );

    const loader = new ActionLoader();
    const config = await (loader as unknown as ActionLoaderPrivate).readActionConfig(yamlPath);

    expect(config.webhook).toBe(true);
  });

  it("rejects non-boolean webhook values", async () => {
    const yamlPath = writeActionYaml(
      [
        "name: send_message",
        "type: system",
        "description: Send a message",
        "complexity: simple",
        "speed: fast",
        "reliability: high",
        "sideEffects: write",
        "webhook: yep",
      ].join("\n"),
    );

    const loader = new ActionLoader();

    await expect(
      (loader as unknown as ActionLoaderPrivate).readActionConfig(yamlPath),
    ).rejects.toThrow("webhook: Invalid input: expected boolean, received string");
  });

  it("rejects an action.yaml with an unknown field", async () => {
    const yamlPath = writeActionYaml(
      [
        "name: send_message",
        "type: system",
        "description: Send a message",
        "complexity: simple",
        "speed: fast",
        "reliability: high",
        "sideEffects: write",
        "retryCount: 3",
      ].join("\n"),
    );

    const loader = new ActionLoader();

    await expect(
      (loader as unknown as ActionLoaderPrivate).readActionConfig(yamlPath),
    ).rejects.toThrow(/retryCount/);
  });

  it("rejects approval-gated webhook actions in v1", async () => {
    const yamlPath = writeActionYaml(
      [
        "name: send_message",
        "type: system",
        "description: Send a message",
        "complexity: simple",
        "speed: fast",
        "reliability: high",
        "sideEffects: write",
        "webhook: true",
        "requiresApproval: true",
      ].join("\n"),
    );

    const loader = new ActionLoader();

    await expect(
      (loader as unknown as ActionLoaderPrivate).readActionConfig(yamlPath),
    ).rejects.toThrow("webhook actions cannot require approval in v1");
  });

  it("rejects approval-gated favor-required actions in v1", async () => {
    const yamlPath = writeActionYaml(
      [
        "name: summarize_report",
        "type: custom",
        "description: Summarize a report",
        "complexity: moderate",
        "speed: slow",
        "reliability: medium",
        "sideEffects: write",
        "requiresApproval: true",
        "favorRequirement:",
        "  amount: 25",
        "  title: Summarize a report",
      ].join("\n"),
    );

    const loader = new ActionLoader();

    await expect(
      (loader as unknown as ActionLoaderPrivate).readActionConfig(yamlPath),
    ).rejects.toThrow("favor-required actions cannot require approval in v1");
  });
});
