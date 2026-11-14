import { describe, expect, it } from "@rstest/core";
import type { TurnFacts } from "../agent/index.js";
import { shareLocationTools } from "./share-location-tool.js";

const turnStartedBy = (actor?: { kind: string; userId?: string; via?: string }) =>
  ({ actor: () => actor }) as unknown as TurnFacts;

const call = async (
  input: {
    widgets?: "card" | "plain_text";
    hasSpeaker?: boolean;
    privateTurn?: (turn: TurnFacts) => Promise<boolean>;
    turn?: TurnFacts;
  },
  args: unknown = { reason: "To find coffee near you" },
) => {
  const [tool] = shareLocationTools({
    turn: input.turn ?? turnStartedBy(),
    widgets: input.widgets ?? "card",
    hasSpeaker: input.hasSpeaker ?? true,
    privateTurn: input.privateTurn,
  });
  return { tool, result: await tool!.handler(args as Record<string, unknown>) };
};

describe("share_location", () => {
  it("ends a private turn on the share-location card, with the agent's reason", async () => {
    const { tool, result } = await call({ privateTurn: async () => true });
    expect(tool?.endsTurn).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      pendingInteraction: true,
      appId: "core",
      render: {
        componentId: "location-card",
        props: { reason: "To find coffee near you" },
        builtin: true,
      },
    });
  });

  it("lets the card share by itself only in a turn the guardian's own message started", async () => {
    const props = async (turn: TurnFacts) => {
      const { result } = await call({ privateTurn: async () => true, turn });
      return JSON.parse(result.content[0]!.text).render.props;
    };
    expect(await props(turnStartedBy({ kind: "guardian", userId: "g", via: "cookie" }))).toEqual({
      reason: "To find coffee near you",
      autoShare: true,
    });
    // A followed event, a routine or a task's result acts for the guardian by loopback.
    expect(await props(turnStartedBy({ kind: "guardian", userId: "g", via: "loopback" }))).toEqual({
      reason: "To find coffee near you",
    });
    expect(await props(turnStartedBy())).toEqual({ reason: "To find coffee near you" });
    expect(await props(turnStartedBy({ kind: "visitor" }))).toEqual({
      reason: "To find coffee near you",
    });
  });

  it("refuses in a turn others can read, with a reason the agent passes on", async () => {
    const { result } = await call({ privateTurn: async () => false });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("others can read this chat");
  });

  it("refuses when no rule says a turn is private", async () => {
    const { result } = await call({});
    expect(result.isError).toBe(true);
  });

  it("refuses where no card shows, and in a fork", async () => {
    const plain = await call({ widgets: "plain_text", privateTurn: async () => true });
    expect(plain.tool?.endsTurn).toBe(false);
    expect(plain.result.isError).toBe(true);
    const fork = await call({ hasSpeaker: false, privateTurn: async () => true });
    expect(fork.result.content[0]!.text).toContain("forked turn");
  });

  it("asks for a reason", async () => {
    const { result } = await call({ privateTurn: async () => true }, { reason: " " });
    expect(result.isError).toBe(true);
  });
});
