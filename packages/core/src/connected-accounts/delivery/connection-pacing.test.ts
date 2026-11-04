import { beforeEach, describe, expect, it } from "@rstest/core";
import type { Connection } from "../../connections/types.js";
import { systemClock } from "../../lib/clock.js";
import { ConnectionPacing } from "./connection-pacing.js";
import { plainText } from "./types.js";

const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };

/** A Connection whose talker declares reply delivery, or none. */
function connection(id: string, streams: boolean, live = true): Connection {
  const talker = {
    ...(streams
      ? {
          replyDelivery: {
            capabilities: { maxPartLength: 10, edit: false, budget },
            codec: plainText,
            create: async () => ({ messageId: "m", chatId: "c" }),
          },
        }
      : {}),
  };
  return {
    id,
    service: "telegram",
    withTalker: (call: (talker: object) => unknown) => (live ? call(talker) : undefined),
  } as unknown as Connection;
}

/** Writes that record when they start, and wait to be released. */
function gatedWrites() {
  const events: string[] = [];
  const releases = new Map<string, () => void>();
  const write = (label: string) => () =>
    new Promise<string>((resolve) => {
      events.push(`start ${label}`);
      releases.set(label, () => {
        events.push(`end ${label}`);
        resolve(label);
      });
    });
  return { events, write, release: (label: string) => releases.get(label)?.() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("ConnectionPacing", () => {
  let on: boolean;
  let pacing: ConnectionPacing;

  beforeEach(() => {
    on = true;
    pacing = new ConnectionPacing(systemClock, async () => on);
  });

  it("holds a Connection's writes to one at a time while streaming is on", async () => {
    const telegram = connection("c1", true);
    const { events, write, release } = gatedWrites();

    const first = pacing.run(telegram, "chat", write("first"));
    const second = pacing.run(telegram, "chat", write("second"));
    await settle();
    expect(events).toEqual(["start first"]);

    release("first");
    await settle();
    release("second");
    await Promise.all([first, second]);
    expect(events).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("runs every write at once while streaming is off", async () => {
    on = false;
    const telegram = connection("c1", true);
    const { events, write, release } = gatedWrites();

    const first = pacing.run(telegram, "chat", write("first"));
    const second = pacing.run(telegram, "chat", write("second"));
    await settle();
    expect(events).toEqual(["start first", "start second"]);
    expect(pacing.pacerFor(telegram)).not.toBeNull();

    release("first");
    release("second");
    await Promise.all([first, second]);
  });

  it("reads the switch on every write, so turning it on applies to the next send", async () => {
    on = false;
    const telegram = connection("c1", true);
    const { events, write, release } = gatedWrites();

    const unpaced = pacing.run(telegram, "chat", write("a"));
    await settle();
    on = true;
    const first = pacing.run(telegram, "chat", write("b"));
    const second = pacing.run(telegram, "chat", write("c"));
    await settle();
    expect(events).toEqual(["start a", "start b"]);

    release("a");
    release("b");
    await settle();
    release("c");
    await Promise.all([unpaced, first, second]);
  });

  it("never holds a Connection whose talker declares no reply delivery", async () => {
    const feishu = connection("c2", false);
    const { events, write, release } = gatedWrites();

    const first = pacing.run(feishu, "chat", write("first"));
    const second = pacing.run(feishu, "chat", write("second"));
    await settle();
    expect(events).toEqual(["start first", "start second"]);
    expect(pacing.pacerFor(feishu)).toBeNull();

    release("first");
    release("second");
    await Promise.all([first, second]);
  });

  it("does not read the switch for a Connection whose talker declares no reply delivery", async () => {
    let reads = 0;
    pacing = new ConnectionPacing(systemClock, async () => {
      reads += 1;
      return true;
    });

    expect(await pacing.run(connection("c2", false), "chat", async () => "sent")).toBe("sent");
    expect(reads).toBe(0);
  });

  it("keeps one pacer for a Connection, and none while its talker is not live", () => {
    const locked = connection("c3", true, false);
    expect(pacing.pacerFor(locked)).toBeNull();

    const telegram = connection("c1", true);
    expect(pacing.pacerFor(telegram)).toBe(pacing.pacerFor(telegram));
    expect(pacing.pacerFor(connection("c4", true))).not.toBe(pacing.pacerFor(telegram));
  });

  it("passes a write's failure on to its caller", async () => {
    const telegram = connection("c1", true);
    await expect(
      pacing.run(telegram, "chat", async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
  });
});
