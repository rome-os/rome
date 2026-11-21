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

  it("asks Rome Cloud for the link that adds the bot, and takes only Discord's", async () => {
    const { cloud, calls } = answering(200, { url: "https://discord.com/oauth2/authorize?x=1" });
    expect(await cloud.installUrl()).toBe("https://discord.com/oauth2/authorize?x=1");
    expect(calls[0]?.url).toBe("https://cloud.test/api/instance/discord/install-url");
    await expect(
      answering(200, { url: "https://evil.test/" }).cloud.installUrl(),
    ).rejects.toBeInstanceOf(DiscordAppRefused);
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
