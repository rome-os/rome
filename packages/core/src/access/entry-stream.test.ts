import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { ENTRY_RECHECK_MS } from "./entry.js";
import { endStreamsOnLostEntry, leaveStreamToApp } from "./entry-stream.js";
import { runWithSessionActor, type SessionActor } from "./session-actor.js";

const member = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;
const guest = { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const;
const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;

let allowList: DashboardAccessState;
let aborted: boolean;

// Writes one event, then holds the stream open until it is aborted.
async function open(actor: SessionActor, setUp: (c: Context) => Promise<void> | void = () => {}) {
  const app = new Hono();
  app.use("*", (_c, next) => runWithSessionActor(actor, next));
  app.use("*", endStreamsOnLostEntry(allowList));
  app.get("/events", async (c) => {
    await setUp(c);
    return streamSSE(c, async (sse) => {
      const gone = new Promise<void>((resolve) => sse.onAbort(resolve));
      await sse.writeSSE({ data: "first" });
      await gone;
      aborted = true;
    });
  });
  const res = await app.request("/events");
  const reader = res.body!.getReader();
  const first = await reader.read();
  return { res, reader, first: first.done ? "ended" : new TextDecoder().decode(first.value) };
}

describe("endStreamsOnLostEntry", () => {
  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    aborted = false;
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("ends a member's stream, and its source, once they are no longer a member", async () => {
    const { res, reader, first } = await open(member);
    expect(first).toContain("first");
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    allowList.setCloudEmailAccess([]);
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    expect((await reader.read()).done).toBe(true);
    await rs.waitFor(() => expect(aborted).toBe(true));
  });

  it("stops the source when the reader goes", async () => {
    const { reader } = await open(member);
    await reader.cancel();
    await rs.waitFor(() => expect(aborted).toBe(true));
  });

  it("ends the stream of a member who left while the route set it up", async () => {
    const { first } = await open(member, async () => {
      await Promise.resolve();
      allowList.setCloudEmailAccess([]);
    });
    expect(first).toBe("ended");
    await rs.waitFor(() => expect(aborted).toBe(true));
  });

  it.each([
    ["the guardian's stream", guardian, () => {}],
    ["an app's stream to a member", member, leaveStreamToApp],
    ["an app's stream to a guest", guest, leaveStreamToApp],
  ] as const)("leaves %s open when the members change", async (_whose, actor, setUp) => {
    const { reader, first } = await open(actor, setUp);
    expect(first).toContain("first");
    allowList.setCloudEmailAccess([]);
    rs.advanceTimersByTime(ENTRY_RECHECK_MS * 2);
    const next = await Promise.race([
      reader.read().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 20)),
    ]);
    expect(next).toBe("open");
    await reader.cancel();
  });
});
