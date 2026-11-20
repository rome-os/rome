import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb } from "../../../test/db.js";
import { SlackAppOpenToMembersRepository } from "./open-to-members.js";

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});

describe("which Slack app accounts are open to their workspace's members", () => {
  it("starts closed, opens and closes one account, and leaves another as it was", () => {
    const testDb = createTestDb();
    open.push(() => testDb.close());
    const store = new SlackAppOpenToMembersRepository(testDb.db);

    expect(store.isOpen("T_A/U_BOT")).toBe(false);
    store.set("T_A/U_BOT", true);
    store.set("T_A/U_BOT", true);
    expect(store.isOpen("T_A/U_BOT")).toBe(true);
    expect(store.isOpen("T_B/U_BOT")).toBe(false);
    store.set("T_A/U_BOT", false);
    expect(store.isOpen("T_A/U_BOT")).toBe(false);
  });
});
