import { describe, expect, it, rs } from "@rstest/core";
import { SlackMemberChannels } from "./channels.js";

const NEWS = { id: "C_NEWS", name: "news", isPrivate: false };
const OPS = { id: "C_OPS", name: "ops", isPrivate: false };

describe("SlackMemberChannels", () => {
  it("asks Slack again for a name its listing lacks once the listing is 10 seconds old", async () => {
    let now = 0;
    let channels = [NEWS];
    const memberChannels = rs.fn(async () => ({ channels }));
    const listing = new SlackMemberChannels({
      api: { memberChannels },
      botToken: "xoxb",
      now: () => now,
    });
    await listing.list();

    // Someone adds the app to #ops with /invite.
    channels = [NEWS, OPS];
    now = 5_000;
    await expect(listing.resolve("#ops")).rejects.toThrow(/not a member of a channel named #ops/);
    now = 10_000;
    const resolved = await listing.resolve("#ops");
    // A name the listing holds asks Slack nothing.
    await listing.resolve("#news");

    expect(resolved).toBe("C_OPS");
    expect(memberChannels).toHaveBeenCalledTimes(2);
  });

  it("resolves a name a renamed channel gave to another by the new listing", async () => {
    let now = 0;
    let channels = [NEWS, OPS];
    const memberChannels = rs.fn(async () => ({ channels }));
    const listing = new SlackMemberChannels({
      api: { memberChannels },
      botToken: "xoxb",
      now: () => now,
    });
    expect(await listing.resolve("#news")).toBe("C_NEWS");

    // #news is renamed #general, and #ops takes the name #news.
    channels = [
      { ...NEWS, name: "general" },
      { ...OPS, name: "news" },
    ];
    now = 1_000;
    // A send reads the listing again, however new it is.
    expect(await listing.resolve("#news", undefined, { fresh: true })).toBe("C_OPS");
    channels = [NEWS, OPS];
    now = 2_000;
    // A read takes a listing up to 10 seconds old, then reads it again.
    expect(await listing.resolve("#news")).toBe("C_OPS");
    now = 11_000;
    expect(await listing.resolve("#news")).toBe("C_NEWS");
    expect(memberChannels).toHaveBeenCalledTimes(3);
  });

  it("refuses a listing longer than it reads, rather than taking a part of it as whole", async () => {
    const memberChannels = rs.fn(async () => ({ channels: [NEWS], nextCursor: "more" }));
    const listing = new SlackMemberChannels({ api: { memberChannels }, botToken: "xoxb" });

    await expect(listing.list()).rejects.toThrow(/too many to list: name a channel by its id/);
    await expect(listing.resolve("#ops")).rejects.toThrow(/too many to list/);
    // A channel named by its id needs no listing.
    expect(await listing.resolve("C_OPS")).toBe("C_OPS");
  });

  it("lists 10,000 channels whole, as far as a directory page's cursor reaches, and refuses one more page", async () => {
    const pageOf = (page: number) =>
      Array.from({ length: 200 }, (_, i) => ({
        id: `C${page * 200 + i}`,
        name: `c${page * 200 + i}`,
        isPrivate: false,
      }));
    const listed = (pages: number) =>
      rs.fn(async (_token: string, read: { cursor?: string }) => {
        const page = read.cursor ? Number(read.cursor) : 0;
        return {
          channels: pageOf(page),
          ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}),
        };
      });

    const whole = new SlackMemberChannels({ api: { memberChannels: listed(50) }, botToken: "x" });
    const over = new SlackMemberChannels({ api: { memberChannels: listed(51) }, botToken: "x" });

    expect(await whole.list()).toHaveLength(10_000);
    await expect(over.list()).rejects.toThrow(/more than 10000 channels/);
  });
});
