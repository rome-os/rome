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
});
