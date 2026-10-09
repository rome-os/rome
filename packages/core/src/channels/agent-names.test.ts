import { describe, expect, it } from "@rstest/core";
import type { ExternalAgent } from "../lib/rome-cloud-agents.js";
import { createAgentNames } from "./agent-names.js";
import { externalAgents } from "./agents-accounts.js";

const HOME = { agentId: "00000000-0000-4000-8000-000000000000", name: "Rome" };
const ATLAS = "0b6f6f8e-8a4c-4f3e-9c9d-2f1a3b4c5d6e";
const FRIEND_ATLAS = "1c7a7f9e-9b5d-4a4f-8d0e-3a2b4c5d6e7f";
const BETA = "2d8b8a0f-0c6e-4b5a-9e1f-4b3c5d6e7f80";

function agent(agentId: string, name: string, account = "ouou"): ExternalAgent {
  return { agentId, name, kind: "dot", account, sameAccount: account === "ouou" };
}

function names(agents: ExternalAgent[], connected = true) {
  let asked = 0;
  const service = createAgentNames(
    externalAgents({
      client: {
        async agents() {
          asked += 1;
          return {
            self: HOME,
            agents: [{ ...HOME, kind: "rome", account: "ouou", sameAccount: true }, ...agents],
          };
        },
      },
      isConnected: () => connected,
    }),
  );
  return { service, asked: () => asked };
}

describe("agent names", () => {
  it("resolves a name one agent has, ignoring case", async () => {
    const { service } = names([agent(ATLAS, "Atlas")]);
    expect(await service.resolve("atlas")).toEqual({ status: "found", agentId: ATLAS });
  });

  it("refuses a name two agents share, with each one's label and id", async () => {
    const { service } = names([agent(ATLAS, "Atlas"), agent(FRIEND_ATLAS, "Atlas", "friend")]);
    expect(await service.resolve("Atlas")).toEqual({
      status: "ambiguous",
      matches: [
        { label: "Atlas (dot)", agentId: ATLAS },
        { label: "Atlas (@friend's dot)", agentId: FRIEND_ATLAS },
      ],
    });
  });

  it("takes a whole label to pick between agents that share a name", async () => {
    const { service } = names([agent(ATLAS, "Atlas"), agent(FRIEND_ATLAS, "Atlas", "friend")]);
    expect(await service.resolve("Atlas (@friend's dot)")).toEqual({
      status: "found",
      agentId: FRIEND_ATLAS,
    });
  });

  it("matches a name exactly, not one that only starts with it", async () => {
    const { service } = names([agent(BETA, "Atlas (beta)"), agent(ATLAS, "Atlasia")]);
    expect(await service.resolve("Atlas")).toEqual({ status: "none" });
  });

  it("never resolves to this Rome", async () => {
    const { service } = names([]);
    expect(await service.resolve("Rome")).toEqual({ status: "none" });
  });

  it("asks Cloud nothing until Agents is connected", async () => {
    const { service, asked } = names([agent(ATLAS, "Atlas")], false);
    expect(await service.resolve("Atlas")).toEqual({ status: "not_connected" });
    expect(asked()).toBe(0);
  });
  it("fails, rather than finding no one, when Cloud cannot be read", async () => {
    const service = createAgentNames(
      externalAgents({
        client: {
          async agents() {
            throw new Error("Cloud is down");
          },
        },
        isConnected: () => true,
      }),
    );
    await expect(service.resolve("Atlas")).rejects.toThrow("Cloud is down");
  });
});
