import { describe, expect, it } from "@rstest/core";
import { createEmptyLegacyArtifactBindings, formatArtifactId } from "./artifact-id.js";
import { loadArtifactRecords } from "./artifact-records.js";
import type { ArtifactMetadata } from "./types.js";

function source(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return {
    kind: "action",
    ownerType: "app",
    ownerId: "app-b",
    publicName: "run",
    aliases: [],
    formatVersion: 1,
    sourcePath: "/x",
    ...overrides,
  };
}

describe("loadArtifactRecords", () => {
  it("registers a version-1 app artifact whose file-name bare name another app holds", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    legacyBindings.action.run = formatArtifactId("app-a", "app_a_run");

    const { records, failures } = await loadArtifactRecords({
      kind: "action",
      sources: [source()],
      identity: { legacyBindings },
      read: async () => ({ name: "app_b_run" }),
    });

    expect(records.has(formatArtifactId("app-b", "app_b_run"))).toBe(true);
    expect(failures).toEqual([]);
    expect(legacyBindings.action.app_b_run).toBe("app-b:app_b_run");
    expect(legacyBindings.action.run).toBe("app-a:app_a_run");
  });

  it("registers a version-1 app artifact whose declared name another app holds", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    legacyBindings.action.chatgpt_chat = formatArtifactId("browser-automation", "chatgpt_chat");

    const { records, failures } = await loadArtifactRecords({
      kind: "action",
      sources: [source({ ownerId: "user-app", publicName: "chat" })],
      identity: { legacyBindings },
      read: async () => ({ name: "chatgpt_chat" }),
    });

    expect(records.has(formatArtifactId("user-app", "chatgpt_chat"))).toBe(true);
    expect(failures).toEqual([]);
    expect(legacyBindings.action.chatgpt_chat).toBe("browser-automation:chatgpt_chat");
    expect(legacyBindings.action.chat).toBe("user-app:chatgpt_chat");
  });

  it("rejects a core artifact whose bare name another artifact holds", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    legacyBindings.action.send_message = formatArtifactId("some-app", "send_message");

    await expect(
      loadArtifactRecords({
        kind: "action",
        sources: [source({ ownerType: "core", ownerId: "core", publicName: "send_message" })],
        identity: { legacyBindings },
        read: async () => ({ name: "send_message" }),
      }),
    ).rejects.toThrow(
      /Legacy action name conflict: "send_message" is bound to some-app:send_message/,
    );
  });

  it("writes no binding for a source that repeats a canonical id", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();

    const { records, failures } = await loadArtifactRecords({
      kind: "action",
      sources: [
        source({ publicName: "first", sourcePath: "/first" }),
        source({ publicName: "second", sourcePath: "/second" }),
      ],
      identity: { legacyBindings },
      read: async () => ({ name: "shared" }),
    });

    expect(records.get(formatArtifactId("app-b", "shared"))?.metadata.sourcePath).toBe("/first");
    expect(failures).toEqual([
      expect.objectContaining({ ownerId: "app-b", publicName: "second", sourcePath: "/second" }),
    ]);
    expect(legacyBindings.action.first).toBe("app-b:shared");
    expect(legacyBindings.action.second).toBeUndefined();
  });
});
