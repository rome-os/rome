import { describe, expect, it } from "@rstest/core";
import type { Action } from "../actions/types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import type { ResolvedApp } from "../apps/state.js";
import { favorActionRequirementsForApp } from "./catalog-sync.js";

function action(
  name: string,
  overrides: Partial<Action> & { ownerId?: string } = {},
): { action: Action; metadata: ArtifactMetadata } {
  const { ownerId = "report-shop", ...actionOverrides } = overrides;
  const action: Action = {
    config: {
      name,
      type: "custom",
      description: name,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ status: "ok" }),
    ...actionOverrides,
  };
  return {
    action,
    metadata: {
      kind: "action",
      ownerType: "app",
      ownerId,
      publicName: name,
      aliases: [],
      sourcePath: `/apps/${ownerId}/${name}`,
    },
  };
}

function catalog(entries: Array<{ action: Action; metadata: ArtifactMetadata }>) {
  return {
    list: () => entries.map((entry) => entry.action.config.name),
    get: (name: string) => entries.find((entry) => entry.action.config.name === name)?.action,
    getMetadata: (name: string) =>
      entries.find((entry) => entry.action.config.name === name)?.metadata,
  };
}

describe("favorActionRequirementsForApp", () => {
  it("derives favor definitions from app-owned action config", () => {
    const app = { appId: "report-shop" } as ResolvedApp;
    const paid = action("summarize_report", {
      config: {
        name: "summarize_report",
        type: "custom",
        description: "Summarize a report",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
        favorRequirement: {
          amount: 25,
          title: "Summarize a report",
          summary: "Create a concise summary.",
          displayFields: [{ label: "Report", from: "$.reportUrl" }],
        },
      },
      inputSchema: {
        type: "object",
        properties: { reportUrl: { type: "string", format: "uri" } },
        required: ["reportUrl"],
      },
    });
    const free = action("free_preview");
    const otherApp = action("other_paid", {
      ownerId: "other-app",
      config: {
        name: "other_paid",
        type: "custom",
        description: "Other",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "write",
        favorRequirement: { amount: 10, title: "Other" },
      },
    });

    expect(favorActionRequirementsForApp(app, catalog([paid, free, otherApp]))).toEqual([
      {
        actionName: "summarize_report",
        amount: 25,
        title: "Summarize a report",
        summary: "Create a concise summary.",
        argsSchema: paid.action.inputSchema,
        displayFields: [{ label: "Report", from: "$.reportUrl" }],
      },
    ]);
  });

  it("requires an input schema for favor-required actions", () => {
    const app = { appId: "report-shop" } as ResolvedApp;
    const paid = action("summarize_report", {
      config: {
        name: "summarize_report",
        type: "custom",
        description: "Summarize a report",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
        favorRequirement: { amount: 25, title: "Summarize a report" },
      },
      inputSchema: undefined,
    });

    expect(() => favorActionRequirementsForApp(app, catalog([paid]))).toThrow(
      'Favor-required action "summarize_report" must expose inputSchema',
    );
  });
});
