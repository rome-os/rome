import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../../../instance/instance-identity.js", () => ({
  cloudBearer: async () => "instance-jwt",
}));
rs.mock("../../../instance/rome-cloud-origin.js", () => ({
  getRomeCloudOrigin: () => "https://cloud.test",
}));

const { isSlackAppCredentialError, romeCloudSlackApp, SlackAppRefused } = await import(
  "./rome-cloud.js"
);

const WORKER = "https://slack.test";

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
  return { cloud: romeCloudSlackApp(WORKER, fetchImpl), calls };
}

const WORKSPACE = {
  teamId: "T_A",
  teamName: "Acme",
  botUserId: "U_BOT",
  installerUserId: "U_GUARDIAN",
  boundAt: 1700000000000,
};

describe("the Slack gateway Worker and Rome Cloud, as the instance calls them", () => {
  it("connects with the instance's token and the mailbox's address, and lists the workspaces held", async () => {
    const { cloud, calls } = answering(200, { depositKey: "k", workspaces: [WORKSPACE] });
    expect(await cloud.connect("https://ingest.test/h/abc.sig")).toEqual({
      depositKey: "k",
      workspaces: [WORKSPACE],
    });
    expect(calls).toEqual([
      {
        url: `${WORKER}/v1/connect`,
        method: "POST",
        auth: "Bearer instance-jwt",
        body: { depositUrl: "https://ingest.test/h/abc.sig" },
      },
    ]);
  });

  it("drops a listed workspace with no team or bot", async () => {
    const { cloud } = answering(200, {
      workspaces: [WORKSPACE, { teamId: "T_B" }, { botUserId: "U" }, null],
    });
    expect(await cloud.workspaces()).toEqual([WORKSPACE]);
  });

  it("disconnects with DELETE on the same address", async () => {
    const { cloud, calls } = answering(200, { released: 1 });
    await cloud.disconnect();
    expect(calls).toMatchObject([{ url: `${WORKER}/v1/connect`, method: "DELETE" }]);
  });

  it("asks Rome Cloud for Slack's approve link, and refuses one that is not Slack's", async () => {
    const { cloud, calls } = answering(200, { url: "https://slack.com/oauth/v2/authorize?x=1" });
    expect(await cloud.installUrl()).toBe("https://slack.com/oauth/v2/authorize?x=1");
    expect(calls).toMatchObject([
      { url: "https://cloud.test/api/instance/slack/install-url", method: "POST" },
    ]);
    await expect(
      answering(200, { url: "https://evil.test/oauth" }).cloud.installUrl(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("words each refusal for the guardian, and tells a refused token apart", async () => {
    const refused = await answering(401, { error: "unauthorized" })
      .cloud.connect("https://ingest.test/h/a.b")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlackAppRefused);
    expect(isSlackAppCredentialError(refused)).toBe(true);
    const bad = await answering(400, { error: "invalid_deposit_url" })
      .cloud.connect("https://ingest.test/h/a.b")
      .catch((error: unknown) => error);
    expect(isSlackAppCredentialError(bad)).toBe(false);
    expect((bad as Error).message).toBe(
      "Rome can't receive Slack messages yet. Try again in a minute.",
    );
  });
});
