import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../../../instance/instance-identity.js", () => ({
  cloudBearer: async () => "instance-jwt",
}));
rs.mock("../../../instance/rome-cloud-origin.js", () => ({
  getRomeCloudOrigin: () => "https://cloud.test",
}));

const { DiscordAppRefused, isDiscordAppCredentialError, romeCloudDiscordApp } = await import(
  "./worker.js"
);

function answering(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: String(init.method),
      auth: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { cloud: romeCloudDiscordApp(fetchImpl), calls };
}

describe("the Discord gateway Worker and Rome Cloud, as the instance calls them", () => {
  it("connects with the instance's token and the mailbox's address", async () => {
    const { cloud, calls } = answering(200, {
      botId: "1",
      botUsername: "Rome",
      depositKey: "k",
    });
    expect(await cloud.connect("https://ingest.test/h/abc.sig")).toEqual({
      botId: "1",
      botUsername: "Rome",
      depositKey: "k",
    });
    expect(calls).toEqual([
      {
        url: "https://discord.romeos.io/v1/connect",
        method: "POST",
        auth: "Bearer instance-jwt",
        body: { depositUrl: "https://ingest.test/h/abc.sig" },
      },
    ]);
  });

  it("words each refusal for the guardian, and tells a refused token apart", async () => {
    const refused = await answering(401, { error: "invalid_token" })
      .cloud.bindings()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DiscordAppRefused);
    expect(isDiscordAppCredentialError(refused)).toBe(true);
    const busy = await answering(503, { error: "discord_unavailable" })
      .cloud.connect("https://ingest.test/h/a.b")
      .catch((error: unknown) => error);
    expect((busy as Error).message).toBe("Discord is unavailable right now. Try again later.");
    expect(isDiscordAppCredentialError(busy)).toBe(false);
  });

  it("posts, reacts and types through the Worker's Discord proxy, mentioning people only", async () => {
    const { cloud, calls } = answering(200, { id: "555555555555555555" });
    expect(
      await cloud.send({
        channelId: "444444444444444444",
        content: "hi",
        replyTo: "333333333333333333",
      }),
    ).toEqual({ id: "555555555555555555" });
    await cloud.send({ channelId: "444444444444444444", content: "again" });
    await cloud.typing("444444444444444444");
    await cloud.react({
      channelId: "444444444444444444",
      messageId: "333333333333333333",
      emoji: "1️⃣",
    });
    await cloud.unreact({
      channelId: "444444444444444444",
      messageId: "333333333333333333",
      emoji: "👀",
    });
    const base = "https://discord.romeos.io/v1/discord/channels/444444444444444444";
    expect(calls).toEqual([
      {
        url: `${base}/messages`,
        method: "POST",
        auth: "Bearer instance-jwt",
        body: {
          content: "hi",
          allowed_mentions: { parse: ["users"], replied_user: false },
          message_reference: { message_id: "333333333333333333", fail_if_not_exists: false },
        },
      },
      {
        url: `${base}/messages`,
        method: "POST",
        auth: "Bearer instance-jwt",
        body: { content: "again", allowed_mentions: { parse: ["users"], replied_user: false } },
      },
      { url: `${base}/typing`, method: "POST", auth: "Bearer instance-jwt", body: undefined },
      {
        url: `${base}/messages/333333333333333333/reactions/${encodeURIComponent("1️⃣")}/@me`,
        method: "PUT",
        auth: "Bearer instance-jwt",
        body: undefined,
      },
      {
        url: `${base}/messages/333333333333333333/reactions/${encodeURIComponent("👀")}/@me`,
        method: "DELETE",
        auth: "Bearer instance-jwt",
        body: undefined,
      },
    ]);
  });

  it("puts nothing but Discord ids into a proxy path", async () => {
    const { cloud, calls } = answering(200, { id: "1" });
    await expect(cloud.typing("../../users/@me")).rejects.toThrow("is not a Discord id");
    await expect(cloud.react({ channelId: "4", messageId: "x/y", emoji: "👍" })).rejects.toThrow(
      "is not a Discord id",
    );
    expect(calls).toEqual([]);
  });

  it("tells Discord's own refusals apart from a refused Rome", async () => {
    const gone = await answering(404, { message: "Unknown Message", code: 10008 })
      .cloud.react({ channelId: "4", messageId: "3", emoji: "👍" })
      .catch((error: unknown) => error);
    expect((gone as Error).message).toBe("That Discord message or channel is gone.");
    const botToken = await answering(401, { message: "401: Unauthorized", code: 0 })
      .cloud.typing("4")
      .catch((error: unknown) => error);
    expect(isDiscordAppCredentialError(botToken)).toBe(false);
    expect((botToken as Error).message).toBe(
      "Discord did not accept Rome's bot right now. Try again later.",
    );
    const elsewhere = await answering(403, { error: "not_bound" })
      .cloud.typing("4")
      .catch((error: unknown) => error);
    expect((elsewhere as Error).message).toBe("Rome is no longer in that Discord server.");
  });

  it("asks Rome Cloud for the link that adds the bot, and takes only Discord's", async () => {
    const { cloud, calls } = answering(200, { url: "https://discord.com/oauth2/authorize?x=1" });
    expect(await cloud.installUrl()).toBe("https://discord.com/oauth2/authorize?x=1");
    expect(calls[0]?.url).toBe("https://cloud.test/api/instance/discord/install-url");
    await expect(
      answering(200, { url: "https://evil.test/" }).cloud.installUrl(),
    ).rejects.toBeInstanceOf(DiscordAppRefused);
  });

  it("reads this instance's servers through the proxy, with icons only from icon hashes", async () => {
    const { cloud, calls } = answering(200, [
      { id: "500000000000000005", name: "Lab", icon: "a".repeat(32) },
      { id: "500000000000000006", name: "Hikes", icon: null },
      { id: "500000000000000007", name: "Odd", icon: "../x" },
      { id: "not an id", name: "Bad" },
    ]);
    expect(await cloud.servers()).toEqual([
      {
        id: "500000000000000005",
        name: "Lab",
        icon: `https://cdn.discordapp.com/icons/500000000000000005/${"a".repeat(32)}.png?size=96`,
      },
      { id: "500000000000000006", name: "Hikes", icon: null },
      { id: "500000000000000007", name: "Odd", icon: null },
    ]);
    expect(calls[0]?.method).toBe("GET");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/discord/users/@me/guilds");
  });

  it("reads the bindings, keeping only well-formed rows", async () => {
    const { cloud } = answering(200, {
      servers: [{ serverId: "5", serverName: "Lab", createdAt: 10 }, { serverName: "no id" }],
      users: [{ userId: "7", createdAt: 11 }, {}],
    });
    expect(await cloud.bindings()).toEqual({
      servers: [{ serverId: "5", serverName: "Lab", createdAt: 10 }],
      users: [{ userId: "7", createdAt: 11 }],
    });
  });
});
