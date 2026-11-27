import { describe, expect, it } from "@rstest/core";
import { appPeople } from "./app-people.js";

describe("appPeople", () => {
  it("answers the guardian's accounts as Access lists them, newest first", async () => {
    const accounts = [
      { platform: "telegram", id: "8123456789" },
      { platform: "slack", id: "U01" },
    ];

    expect(await appPeople({ guardianAccounts: async () => accounts }).guardian()).toEqual({
      accounts,
    });
  });

  it("answers no accounts while nobody is the guardian", async () => {
    expect(await appPeople({ guardianAccounts: async () => [] }).guardian()).toEqual({
      accounts: [],
    });
  });
});
