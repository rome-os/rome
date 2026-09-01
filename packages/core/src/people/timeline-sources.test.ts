import { describe, expect, it } from "@rstest/core";
import type { Account, AccountId, Accounts } from "../channels/accounts.js";
import type { Channels } from "../channels/channel.js";
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

  constructor(
    private readonly accounts: readonly Account[],
    /** Addresses the listing does not spell out but the channel still answers
     *  for, as a real address book does: a bare phone number, a profile URL. */
    private readonly alsoResolves: Readonly<Record<string, string>> = {},
  ) {}

  async listAccounts(_input: { query?: string; cursor?: string; limit: number }) {
    this.listings++;
    return { accounts: [...this.accounts] };
  }

  async resolve(address: string): Promise<Account | null> {
    const named = this.alsoResolves[address] ?? address;
    return this.accounts.find((candidate) => candidate.addresses.includes(named)) ?? null;
  }
}

/** A channel list as this file reads one: names bound to address books, a null
 *  book for a channel that can say nothing about who it reaches. No message
 *  store, since nothing under test reads a history. */
const channelList = (books: Record<string, Accounts | null>): Channels =>
  Object.entries(books).map(([name, accounts]) => ({ name, accounts, messages: null }));

const ada = "12025550100@s.whatsapp.net";
const adaLid = "77770001@lid";
const grace = "12025550111@s.whatsapp.net";
const adaTelegram = "778001";
const adaTelegramHandle = "@ada";

describe("timelineAccounts", () => {
  it("collapses two addresses of one account onto one account", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [
        { channel: "whatsapp", channelUserId: ada },
        { channel: "whatsapp", channelUserId: adaLid },
      ],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: [ada, adaLid] }]);
    expect(whatsapp.listings).toBe(1);
  });

  it("reads one account per channel, each folded by that channel's own book", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])]);
    const telegram = new FakeAccounts([account(adaTelegram, [adaTelegram, adaTelegramHandle])]);

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp, telegram }) }, [
      [
        { channel: "whatsapp", channelUserId: adaLid },
        { channel: "telegram", channelUserId: adaTelegramHandle },
      ],
    ]);

    expect(
      accounts?.map((found) => ({ ...found, addresses: [...found.addresses].sort() })),
    ).toEqual([
      { channel: "whatsapp", addresses: [ada, adaLid].sort() },
      { channel: "telegram", addresses: [adaTelegram, adaTelegramHandle].sort() },
    ]);
    expect(whatsapp.listings).toBe(1);
    expect(telegram.listings).toBe(1);
  });

  it("folds an address only the channel can resolve onto its account", async () => {
    // The link names a bare phone number. The listing spells out no such
    // address, and only the channel knows it reaches Ada — which is why the
    // fold asks the channel rather than matching the listing itself.
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])], {
      "+1 202 555 0100": ada,
    });

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [{ channel: "whatsapp", channelUserId: "+1 202 555 0100" }],
    ]);

    expect(accounts).toHaveLength(1);
    expect([...(accounts[0]?.addresses ?? [])].sort()).toEqual(
      ["+1 202 555 0100", ada, adaLid].sort(),
    );
  });

  it("carries every address of an account a mapping names under one of them", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(accounts).toHaveLength(1);
    expect([...(accounts[0]?.addresses ?? [])].sort()).toEqual([ada, adaLid].sort());
  });

  it("keeps two accounts apart", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [
        { channel: "whatsapp", channelUserId: adaLid },
        { channel: "whatsapp", channelUserId: grace },
      ],
    ]);

    expect(accounts).toHaveLength(2);
  });

  it("gives an address the address book does not hold its own timeline", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [{ channel: "whatsapp", channelUserId: "12025550999@s.whatsapp.net" }],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: ["12025550999@s.whatsapp.net"] }]);
  });

  it("gives a channel with no address book the link's own address", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts(
      { channels: channelList({ whatsapp, linkedin: null }) },
      [[{ channel: "linkedin", channelUserId: "ACoAAAda0001" }]],
    );

    expect(accounts).toEqual([{ channel: "linkedin", addresses: ["ACoAAAda0001"] }]);
    // No mapping named WhatsApp, so its address book is never read.
    expect(whatsapp.listings).toBe(0);
  });

  it("answers one result per group, in the order given", async () => {
    const whatsapp = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const groups = await timelineAccounts({ channels: channelList({ whatsapp }) }, [
      [{ channel: "whatsapp", channelUserId: grace }],
      [],
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([{ channel: "whatsapp", addresses: [grace] }]);
    expect(groups[1]).toEqual([]);
    expect(groups[2]?.[0]?.channel).toBe("whatsapp");
    // One read serves every group.
    expect(whatsapp.listings).toBe(1);
  });
});
