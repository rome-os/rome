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
  it("raises connected once at the grant that mints the connection", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      await registry.giveGrant("fake-telegram", undefined, "bot", fixture.validCredential());

      expect(heard).toEqual(["connected fake-telegram"]);
    } finally {
      close();
    }
  });

  it("raises fixed when a grant replaces the grant of a connection that exists", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      const connection = await registry.connect("fake-telegram");
      await registry.giveGrant("fake-telegram", connection.id, "bot", fixture.validCredential());
      await registry.giveGrant("fake-telegram", connection.id, "bot", fixture.validCredential());

      expect(heard).toEqual([
        "connected fake-telegram",
        "fixed fake-telegram",
        "fixed fake-telegram",
      ]);
    } finally {
      close();
    }
  });

  it("raises disconnected alone when the connection is disconnected", async () => {
    const { registry, fixture, heard, close } = setup();
    try {
      const connection = await registry.giveGrant(
        "fake-telegram",
        undefined,
        "bot",
        fixture.validCredential(),
      );
      heard.length = 0;

      await registry.disconnect(connection.id);

      expect(heard).toEqual(["disconnected fake-telegram"]);
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
        registry.giveGrant("fake-telegram", connection.id, "bot", fixture.validCredential()),
      ).rejects.toThrow("injected subscriber failure");

      await expect(repository.grantOf(connection.id)).resolves.toMatchObject({
        state: "unauthorized",
      });
      expect(connection.isUnlocked("chat")).toBe(false);
    } finally {
      close();
    }
  });

  it("leaves the connection as it was when the disconnect's subscriber throws", async () => {
    const { registry, repository, fixture, close } = setup((event) => {
      if (event.kind === "disconnected") throw new Error("injected subscriber failure");
    });
    try {
      const connection = await registry.giveGrant(
        "fake-telegram",
        undefined,
        "bot",
        fixture.validCredential(),
      );

      await expect(registry.disconnect(connection.id)).rejects.toThrow(
        "injected subscriber failure",
      );

      expect(registry.get(connection.id)).toBe(connection);
      expect(connection.isUnlocked("chat")).toBe(true);
      await expect(repository.grantOf(connection.id)).resolves.toMatchObject({
        state: "authorized",
      });
    } finally {
      close();
    }
  });
});
