import { afterEach, describe, it, expect } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { makeWebchatDescriptor } from "./integrations/webchat.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { ensureZeroGrantConnections } from "./zero-grant.js";

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

// Zero-grant services (webchat)

describe("ensureZeroGrantConnections", () => {
  it("mints a webchat connection when registered + absent (idempotent)", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeWebchatDescriptor({ webchatRepo: {} as never }));

    await ensureZeroGrantConnections(registry);
    expect(registry.find("webchat")).toHaveLength(1);
    // webchat is zero-grant → unlocked at birth
    expect(registry.find("webchat")[0].isUnlocked("talk")).toBe(true);

    // Idempotent: a second run does not create a duplicate connection.
    await ensureZeroGrantConnections(registry);
    expect(registry.find("webchat")).toHaveLength(1);
  });

  it("skips services this registry does not declare (no throw)", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    // webchat NOT registered — must be a no-op, not a "no registered descriptor" throw.
    await expect(ensureZeroGrantConnections(registry)).resolves.toBeUndefined();
    expect(registry.find("webchat")).toHaveLength(0);
  });
});
