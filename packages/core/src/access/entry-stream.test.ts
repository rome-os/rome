import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { ENTRY_RECHECK_MS } from "./entry.js";
import { endStreamsOnLostEntry } from "./entry-stream.js";
import { runWithSessionActor, type SessionActor } from "./session-actor.js";

const member = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;
const guest = { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const;
const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;

let allowList: DashboardAccessState;
let aborted: boolean;

// Writes one event, then holds the stream open until it is aborted.
async function open(actor: SessionActor) {
  const app = new Hono();
  app.use("*", (_c, next) => runWithSessionActor(actor, next));
  app.use("*", endStreamsOnLostEntry(allowList));
  app.get("/events", (c) =>
    streamSSE(c, async (sse) => {
      await sse.writeSSE({ data: "first" });
      await new Promise<void>((resolve) => sse.onAbort(resolve));
      aborted = true;
    }),
  );
  const res = await app.request("/events");
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("first");
  return { res, reader };
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
    const { res, reader } = await open(member);
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

  it.each([
    guardian,
    guest,
  ])("leaves a $kind's stream open when the members change", async (actor) => {
    const { reader } = await open(actor);
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
