import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { AppManifestSchema } from "./manifest.js";

const base = { formatVersion: 1, id: "events-app", version: "0.0.1", description: "for agents" };
const github = {
  events: "provider:event:github.*",
  keys: [["repository.full_name"], ["organization.login"]],
  types: ["push", "workflow_run"],
  ensureAction: "events_ensure",
};

describe("AppManifestSchema eventSources", () => {
  it("accepts a source with keys and types", () => {
    expect(AppManifestSchema.parse({ ...base, eventSources: [github] }).eventSources).toEqual([
      github,
    ]);
  });

  it("accepts a source without keys or types", () => {
    const source = { events: "provider:event:gmail.*", ensureAction: "events_ensure" };
    expect(AppManifestSchema.parse({ ...base, eventSources: [source] }).eventSources).toEqual([
      source,
    ]);
  });

  it("rejects types when the events glob has no single *", () => {
    expect(() =>
      AppManifestSchema.parse({
        ...base,
        eventSources: [{ ...github, events: "provider:event:github.push" }],
      }),
    ).toThrow(/exactly one \*/);
  });

  it("rejects an empty key set, a missing ensureAction, and unknown fields", () => {
    for (const source of [
      { ...github, keys: [[]] },
      { events: github.events },
      { ...github, scope: "repo" },
    ]) {
      expect(AppManifestSchema.safeParse({ ...base, eventSources: [source] }).success).toBe(false);
    }
  });

  it("parses the connector app's declaration", async () => {
    const path = fileURLToPath(
      new URL("../../../../../rome_apps/connector/app.yaml", import.meta.url),
    );
    const manifest = AppManifestSchema.parse(parseYaml(await readFile(path, "utf-8")));
    expect(manifest.eventSources).toEqual([
      expect.objectContaining({
        events: "provider:event:github.*",
        keys: [["repository.full_name"], ["organization.login"]],
        ensureAction: "connector_event_ensure",
      }),
    ]);
    expect(manifest.eventSources?.[0]?.types).toEqual(
      expect.arrayContaining(["workflow_run", "pull_request", "check_suite"]),
    );
  });
});
