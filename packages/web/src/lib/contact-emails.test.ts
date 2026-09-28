import { describe, expect, it } from "@rstest/core";
import type { DirectoryAccount } from "@rome/api-types/people";
import { contactEmailSuggestions } from "./contact-emails";

function account(overrides: Partial<DirectoryAccount>): DirectoryAccount {
  return {
    channel: "email",
    channelUserId: "ada@example.com",
    addresses: ["ada@example.com"],
    displayName: "Ada Lovelace",
    state: "unlinked",
    personId: null,
    personName: null,
    ...overrides,
  };
}

describe("contactEmailSuggestions", () => {
  it("offers each email account's addresses, named by the person when linked", () => {
    const result = contactEmailSuggestions([
      account({ personId: "ada", personName: "Ada L.", state: "linked" }),
      account({
        channelUserId: "grace@example.com",
        addresses: ["Grace@Example.com"],
        displayName: "Grace Hopper",
      }),
    ]);

    expect(result).toEqual([
      { email: "ada@example.com", name: "Ada L." },
      { email: "grace@example.com", name: "Grace Hopper" },
    ]);
  });

  it("drops a name that is only the address again", () => {
    const [only] = contactEmailSuggestions([account({ displayName: "ada@example.com" })]);
    expect(only).toEqual({ email: "ada@example.com", name: null });
  });

  it("skips dismissed accounts, namespaced ids, and other channels' look-alike ids", () => {
    const result = contactEmailSuggestions([
      account({ state: "dismissed" }),
      account({
        channelUserId: "unauthenticated:mallory@example.com",
        addresses: ["unauthenticated:mallory@example.com"],
      }),
      account({ channel: "whatsapp", addresses: ["14155550142@s.whatsapp.net"] }),
      account({ channel: "linkedin", addresses: ["someone@example.com"] }),
    ]);

    expect(result).toEqual([]);
  });

  it("leaves out addresses already listed and repeats of one address", () => {
    const result = contactEmailSuggestions(
      [
        account({}),
        account({ channelUserId: "ada2", displayName: "Ada again" }),
        account({ addresses: ["bob@example.com"], displayName: "Bob" }),
      ],
      { exclude: ["bob@example.com"] },
    );

    expect(result.map((s) => s.email)).toEqual(["ada@example.com"]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      account({ addresses: [`p${i}@example.com`], displayName: `P${i}` }),
    );
    expect(contactEmailSuggestions(many, { limit: 3 })).toHaveLength(3);
  });
});
