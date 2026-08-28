import { describe, expect, it } from "@rstest/core";
import type { ArtifactMetadata } from "../apps/types.js";
import type { AppCatalog } from "../apps/catalog.js";
import { createRegistryAppResolver } from "./registry-app-resolver.js";

const appMetadata: ArtifactMetadata = {
  kind: "action",
  ownerType: "app",
  ownerId: "calendar",
  publicName: "calendar_create_event",
  aliases: [],
  sourcePath: "/apps/calendar/actions/create-event.yaml",
};

function createResolver() {
  return createRegistryAppResolver({
    appCatalog: {
      get(appId: string) {
        if (appId !== "calendar") return null;
        return {
          appId: "calendar",
          displayName: "Calendar",
          iconAbsolutePath: "/apps/calendar/icon.svg",
          manifest: { version: "1.2.3" },
        };
      },
    } as unknown as AppCatalog,
    actionRegistry: {
      getMetadata(actionName: string) {
        return actionName === "calendar_create_event" ? appMetadata : undefined;
      },
    },
    agentLoader: {
      getAllRecords: () => new Map(),
    },
  });
}

describe("createRegistryAppResolver", () => {
  it.each([
    "execute",
    "execute_action",
  ])("resolves %s shims to the app that owns the action", (tool) => {
    const resolver = createResolver();

    expect(
      resolver.resolveTool({
        type: "tool_use",
        tool,
        input: { action_name: "calendar_create_event" },
      }),
    ).toEqual({
      id: "calendar",
      name: "Calendar",
      iconUrl: "/api/apps/calendar/icon",
    });
  });
});
