import { describe, expect, it } from "@rstest/core";
import type { Accounts } from "../chats/accounts/accounts.js";
import { createTestDb } from "../test/helpers.js";
import { addressBooks, connectionKinds, messageStores } from "./connection-kind.js";

const noAccounts = (): Accounts => ({
  listAccounts: async () => ({ accounts: [] }),
  resolve: async () => null,
});

describe("connectionKinds", () => {
  it("lists the synced kinds with their history, then the address books given by kind", () => {
    const testDb = createTestDb();
    try {
      const agents = noAccounts();
      const kinds = connectionKinds({
        db: testDb.db,
        whatsAppAccounts: noAccounts(),
        linkedInAccounts: noAccounts(),
        accounts: { agents },
      });

      expect(kinds.map((kind) => kind.name)).toEqual(["whatsapp", "linkedin", "agents"]);
      expect(kinds[0]?.messages).not.toBeNull();
      expect(kinds[2]).toEqual({ name: "agents", accounts: agents, messages: null });
      expect(messageStores(kinds)).toHaveLength(2);
    } finally {
      testDb.close();
    }
  });

  it("files each address book under its kind's platform, the first kind on a platform winning", () => {
    const first = noAccounts();
    const second = noAccounts();
    const books = addressBooks(
      [
        { name: "telegram", accounts: first, messages: null },
        { name: "telegram_user", accounts: second, messages: null },
        { name: "slack", accounts: null, messages: null },
      ],
      (name) => (name.startsWith("telegram") ? "telegram" : name),
    );

    expect(books).toEqual({ telegram: first });
  });
});
