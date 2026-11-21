import { describe, expect, it } from "@rstest/core";
import type { ConnectionRegistry } from "../../registry.js";
import { deliverDiscordFrame, isDiscordFrame } from "./drain.js";

const body = new TextEncoder().encode("{}");

function registry(
  connections: Array<{ id: string; connectionKind: string }>,
  ingest: (id: string, input: unknown) => Promise<unknown>,
) {
  return { all: () => connections, ingest } as unknown as Pick<
    ConnectionRegistry,
    "all" | "ingest"
  >;
}

describe("Discord frames in the instance's mailbox", () => {
  it("are told apart by the Worker's header, whatever its case", () => {
    expect(isDiscordFrame({ "X-Rome-Discord": "1" })).toBe(true);
    expect(isDiscordFrame({ "x-rome-discord": "1" })).toBe(true);
    expect(isDiscordFrame({ "x-github-event": "push" })).toBe(false);
  });

  it("go to Rome's Discord bot with their signature, and answer what it answered", async () => {
    const seen: unknown[] = [];
    const answer = await deliverDiscordFrame(
      registry([{ id: "conn-1", connectionKind: "discord_app" }], async (id, input) => {
        seen.push([id, input]);
        return { status: 401 };
      }),
      { headers: { "x-rome-discord": "1", "x-rome-discord-signature": "abc" }, body },
    );
    expect(answer).toEqual({ status: 401 });
    expect(seen).toEqual([["conn-1", { body, signature: "abc" }]]);
  });

  it("are dropped and acknowledged with the bot off or its connection not running", async () => {
    expect(
      await deliverDiscordFrame(
        registry([], async () => ({ status: 200 })),
        { headers: {}, body },
      ),
    ).toEqual({ status: 200 });
    expect(
      await deliverDiscordFrame(
        registry([{ id: "conn-1", connectionKind: "discord_app" }], async () => {
          throw new Error('Ingress is unavailable for connection "conn-1"');
        }),
        { headers: {}, body },
      ),
    ).toEqual({ status: 200 });
  });
});
