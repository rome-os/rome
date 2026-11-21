import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../../../instance/instance-identity.js", () => ({
  cloudBearer: async () => "instance-token",
}));
rs.mock("../../../instance/rome-cloud-origin.js", () => ({
  getRomeCloudOrigin: () => "https://cloud.test",
}));

const { romeCloudSlackApp } = await import("./rome-cloud.js");

const INSTALL = {
  teamId: "T_A",
  botUserId: "U_BOT",
  botToken: "xoxb-a",
  forwardSecret: "secret",
  mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
};

function cloudAnswering(answer: unknown) {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json(answer);
  }) as unknown as typeof fetch;
  return { cloud: romeCloudSlackApp(fetchImpl), bodies };
}

describe("Rome Cloud's Slack app routes, as the instance calls them", () => {
  it("keeps the generation a connect was given, and drops one that is not a claim", async () => {
    expect(
      await cloudAnswering({ ...INSTALL, generation: 3 }).cloud.redeem({
        handoff: "h",
        codeVerifier: "v",
      }),
    ).toMatchObject({ generation: 3 });
    for (const generation of [0, 1.5, "3"]) {
      const install = await cloudAnswering({ ...INSTALL, generation }).cloud.redeem({
        handoff: "h",
        codeVerifier: "v",
      });
      expect(install.generation).toBeUndefined();
    }
  });

  it("names the generation on release only when it has one", async () => {
    const { cloud, bodies } = cloudAnswering({ released: true });
    await cloud.release("T_A", undefined, 2);
    await cloud.release("T_A");
    expect(bodies).toEqual([{ teamId: "T_A", generation: 2 }, { teamId: "T_A" }]);
  });
});
