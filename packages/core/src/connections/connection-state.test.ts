// A connection is working or broken (docs/domains/connections.md). The state
// follows its grant: broken while the platform rejects it, working again once
// access is given again, and neither once a disconnect leaves no access.

import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { ConnectionRegistry } from "./registry.js";
import { CredentialRejected, makePasteTalk } from "./test-fixtures.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function connected() {
  const registry = new ConnectionRegistry({
    repository: new DrizzleConnectionsRepository(createTestDb().db),
  });
  const fx = makePasteTalk();
  registry.register(fx.descriptor);
  const conn = await registry.connect("fake-telegram");
  await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
  return { registry, fx, conn };
}

describe("connection state", () => {
  it("is working once its grant is given", async () => {
    const { conn } = await connected();
    expect(conn.state()).toBe("working");
  });

  it("is broken when the platform rejects the grant, and working once fixed", async () => {
    const { registry, fx, conn } = await connected();

    expect(() =>
      conn.withTalker(() => {
        throw new CredentialRejected({ grant: "bot" });
      }),
    ).toThrow(CredentialRejected);
    await flush();
    expect(conn.state()).toBe("broken");

    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
    expect(conn.state()).toBe("working");
  });

  it("has no state once a disconnect leaves it no access", async () => {
    const { conn } = await connected();
    await conn.auth.revoke("bot");
    expect(conn.state()).toBeNull();
  });
});
