import { describe, expect, it } from "@rstest/core";
import { foldAccounts } from "./account-fold.js";
import type { Account, AccountId, Accounts } from "./accounts.js";

const account = (id: string, addresses: string[] = [id], name: string | null = null): Account => ({
  id: id as AccountId,
  addresses,
  name,
  identifiers: {},
});

/**
 * A channel answering the whole of what a fold may ask it: a listing whose
 * accounts carry their own address sets, and `resolve` for an address the
 * listing does not carry.
 *
 * It is an `Accounts` and nothing more — no address map and no history — so a
 * fold reaching for a second source of either fails here rather than quietly
 * reading one.
 */
class FakePlane implements Accounts {
  listings = 0;
  readonly resolved: string[] = [];

  constructor(
    private readonly accounts: readonly Account[],
    private readonly options: {
      /** Addresses the listing does not carry, and the account each names. */
      resolves?: Map<string, Account>;
    } = {},
  ) {}

  async listAccounts(_input: { query?: string; cursor?: string; limit: number }) {
    this.listings++;
    return { accounts: [...this.accounts] };
  }

  async resolve(address: string): Promise<Account | null> {
    this.resolved.push(address);
    return (
      this.options.resolves?.get(address) ??
      this.accounts.find((candidate) => candidate.addresses.includes(address)) ??
      null
    );
  }
}

const ada = "12025550100@s.whatsapp.net";
const adaLid = "77770001@lid";
const grace = "12025550111@s.whatsapp.net";

describe("foldAccounts", () => {
  it("takes an account's address set from the account itself", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid], "Ada")]);

    const fold = await foldAccounts({ whatsapp }, { stored: [] });

    expect(fold.accounts).toEqual([
      {
        channel: "whatsapp",
        channelUserId: ada,
        aliases: [ada, adaLid].sort(),
        name: "Ada",
      },
    ]);
    // Both addresses name the one account, whichever one a caller holds.
    expect(fold.canonical("whatsapp", adaLid)).toBe(ada);
    expect(fold.canonical("whatsapp", ada)).toBe(ada);
    expect(fold.accountFor("whatsapp", adaLid)?.name).toBe("Ada");
    expect(whatsapp.listings).toBe(1);
  });

  it("leaves an account the channel holds one address for addressing itself", async () => {
    const linkedin = new FakePlane([account("ACoAAAda0001")]);

    const fold = await foldAccounts({ linkedin }, { stored: [] });

    expect(fold.accounts[0]?.aliases).toEqual(["ACoAAAda0001"]);
    expect(fold.canonical("linkedin", "ACoAAAda0001")).toBe("ACoAAAda0001");
  });

  it("folds a stored address the listing does not carry through resolve", async () => {
    const member = account("ACoAAAda0001");
    const profileUrl = "https://www.linkedin.com/in/ACoAAAda0001/";
    const linkedin = new FakePlane([member], { resolves: new Map([[profileUrl, member]]) });

    const fold = await foldAccounts(
      { linkedin },
      { stored: [{ channel: "linkedin", channelUserId: profileUrl }] },
    );

    expect(linkedin.resolved).toEqual([profileUrl]);
    expect(fold.canonical("linkedin", profileUrl)).toBe("ACoAAAda0001");
    expect(fold.accountFor("linkedin", profileUrl)?.channelUserId).toBe("ACoAAAda0001");
    // The stored form stays the caller's: the fold reads it, it does not
    // publish it as an address of the account.
    expect(fold.accounts[0]?.aliases).toEqual(["ACoAAAda0001"]);
  });

  it("keeps the listing's owner for a stored address the listing already carries", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid]), account(grace)], {
      // A channel that answered otherwise must not move an address its own
      // listing already placed.
      resolves: new Map([[adaLid, account(grace)]]),
    });

    const fold = await foldAccounts(
      { whatsapp },
      { stored: [{ channel: "whatsapp", channelUserId: adaLid }] },
    );

    expect(fold.canonical("whatsapp", adaLid)).toBe(ada);
  });

  it("reads each channel once, whatever it is asked afterwards", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid])]);
    const linkedin = new FakePlane([account("ACoAAAda0001")]);

    const fold = await foldAccounts(
      { whatsapp, linkedin },
      {
        stored: [
          { channel: "whatsapp", channelUserId: adaLid },
          { channel: "whatsapp", channelUserId: adaLid },
        ],
      },
    );

    expect(fold.accounts).toHaveLength(2);
    expect(whatsapp.listings).toBe(1);
    expect(linkedin.listings).toBe(1);
    // The duplicate stored address is one question, not two.
    expect(whatsapp.resolved).toEqual([adaLid]);
  });
});
