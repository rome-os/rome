import { describe, expect, it } from "@rstest/core";
import type { Account, AccountId } from "../channels/accounts.js";
import { timelineAccounts } from "./timeline-sources.js";

const account = (id: string, addresses: string[] = [id]): Account => ({
  id: id as AccountId,
  addresses,
  name: null,
  identifiers: {},
});

/** A channel that answers the listing and `resolve`, and holds no separate
 *  address map — so a caller that reaches for one fails here. */
class FakeAccounts {
  listings = 0;

  constructor(private readonly accounts: readonly Account[]) {}

  async listAccounts(_input: { query?: string; cursor?: string; limit: number }) {
    this.listings++;
    return { accounts: [...this.accounts] };
  }

  async resolve(address: string): Promise<Account | null> {
    return this.accounts.find((candidate) => candidate.addresses.includes(address)) ?? null;
  }
}

const ada = "12025550100@s.whatsapp.net";
const adaLid = "77770001@lid";
const grace = "12025550111@s.whatsapp.net";

describe("timelineAccounts", () => {
  it("collapses two addresses of one account onto one account", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [
        { channel: "whatsapp", channelUserId: ada },
        { channel: "whatsapp", channelUserId: adaLid },
      ],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: [ada, adaLid] }]);
    expect(whatsAppAccounts.listings).toBe(1);
  });

  it("carries every address of an account a mapping names under one of them", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(accounts).toHaveLength(1);
    expect([...(accounts[0]?.addresses ?? [])].sort()).toEqual([ada, adaLid].sort());
  });

  it("keeps two accounts apart", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [
        { channel: "whatsapp", channelUserId: adaLid },
        { channel: "whatsapp", channelUserId: grace },
      ],
    ]);

    expect(accounts).toHaveLength(2);
  });

  it("gives an address the address book does not hold its own timeline", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: "12025550999@s.whatsapp.net" }],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: ["12025550999@s.whatsapp.net"] }]);
  });

  it("gives a channel with no address book the link's own address", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "linkedin", channelUserId: "ACoAAAda0001" }],
    ]);

    expect(accounts).toEqual([{ channel: "linkedin", addresses: ["ACoAAAda0001"] }]);
    // No mapping named WhatsApp, so its address book is never read.
    expect(whatsAppAccounts.listings).toBe(0);
  });

  it("answers one result per group, in the order given", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const groups = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: grace }],
      [],
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([{ channel: "whatsapp", addresses: [grace] }]);
    expect(groups[1]).toEqual([]);
    expect(groups[2]?.[0]?.channel).toBe("whatsapp");
    // One read serves every group.
    expect(whatsAppAccounts.listings).toBe(1);
  });
});
