import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import type { ConnectionEvent } from "./events.js";
import { ConnectionRegistry } from "./registry.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { makePasteTalk } from "./test-fixtures.js";

function setup(onEvent?: (event: ConnectionEvent) => void) {
  const { db, close } = createTestDb();
  const repository = new DrizzleConnectionsRepository(db);
  const heard: string[] = [];
  const registry = new ConnectionRegistry({
    repository,
    onEvent: (_tx, event) => {
      onEvent?.(event);
      heard.push(`${event.kind} ${event.connection.connectionKind}`);
    },
  });
  const fixture = makePasteTalk();
  registry.register(fixture.descriptor);
  return { registry, repository, fixture, heard, close };
}

describe("connection events", () => {
  it("raises connected once at the conferral that mints the connection", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      await registry.confer("fake-telegram", undefined, "bot", fixture.validCredential());

      expect(heard).toEqual(["connected fake-telegram"]);
    } finally {
      close();
    }
  });

  it("raises fixed when a conferral replaces the grant of a connection that exists", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      const connection = await registry.connect("fake-telegram");
      await registry.confer("fake-telegram", connection.id, "bot", fixture.validCredential());
      await registry.confer("fake-telegram", connection.id, "bot", fixture.validCredential());

      expect(heard).toEqual([
        "connected fake-telegram",
        "fixed fake-telegram",
        "fixed fake-telegram",
      ]);
    } finally {
      close();
    }
  });

  it("raises revoked, then disconnected, when the connection is disconnected", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      const connection = await registry.confer(
        "fake-telegram",
        undefined,
        "bot",
        fixture.validCredential(),
      );
      heard.length = 0;

      await expect(registry.disconnect(connection.id)).resolves.toBe(true);

      expect(heard).toEqual(["revoked fake-telegram", "disconnected fake-telegram"]);
    } finally {
      close();
    }
  });

  it("rolls the fix back when a subscriber throws", async () => {
    const { registry, repository, fixture, close } = setup((event) => {
      if (event.kind === "fixed") throw new Error("injected subscriber failure");
    });
    try {
      const connection = await registry.connect("fake-telegram");

      await expect(
        registry.confer("fake-telegram", connection.id, "bot", fixture.validCredential()),
      ).rejects.toThrow("injected subscriber failure");

      await expect(repository.grantOf(connection.id)).resolves.toMatchObject({
        state: "unauthorized",
      });
      expect(connection.isUnlocked("talk")).toBe(false);
    } finally {
      close();
    }
  });
});
