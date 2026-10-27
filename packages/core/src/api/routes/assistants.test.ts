import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import { Hono } from "hono";
import type { AssistantList } from "@rome/api-types/assistants";
import type { OutboxMessage, TimelinePage } from "@rome/api-types/people";
import { assistantsRoutes } from "./assistants.js";
import { buildTestDeps, createTestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import type { ExternalAgent } from "../../lib/rome-cloud-agents.js";

// Assistants: the agents Rome Cloud lists, each one chat. What these pin is
// that an assistant is listed before anyone has written, that the guardian's
// line goes to the assistant and onto its chat, and that only an agent id
// addresses one.

const DOT = "11111111-1111-4111-8111-111111111111";
const MUSE = "22222222-2222-4222-8222-222222222222";

const agent = (agentId: string, name: string, kind: string): ExternalAgent => ({
  agentId,
  name,
  kind,
  account: "eric",
  sameAccount: true,
});

describe("Assistants API", () => {
  let deps: TestDeps;
  let app: Hono;
  let listing: Promise<ExternalAgent[]>;
  let connected: boolean;

  beforeEach(async () => {
    const testDb = createTestDb();
    await seedBaseline(testDb.db);
    connected = true;
    listing = Promise.resolve([agent(DOT, "Research dot", "dot"), agent(MUSE, "Muse", "muse")]);
    deps = await buildTestDeps(testDb.db, {
      channels: ["agents", "webchat"],
      assistants: { connected: () => connected, list: () => listing },
    });
    app = new Hono().route("/", assistantsRoutes(deps));
  });

  const list = async (): Promise<AssistantList> => (await app.request("/assistants")).json();
  const send = (agentId: string, body: unknown) =>
    app.request(`/assistants/${agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists every assistant before anyone has written, by name", async () => {
    expect((await list()).assistants).toEqual([
      {
        agentId: MUSE,
        name: "Muse",
        kind: "muse",
        account: "eric",
        sameAccount: true,
        lastMessageAt: null,
      },
      {
        agentId: DOT,
        name: "Research dot",
        kind: "dot",
        account: "eric",
        sameAccount: true,
        lastMessageAt: null,
      },
    ]);
  });

  it("leaves other Romes out", async () => {
    listing = Promise.resolve([
      agent(DOT, "Research dot", "dot"),
      agent("33333333-3333-4333-8333-333333333333", "Cloud Rome", "rome"),
    ]);
    expect((await list()).assistants.map((assistant) => assistant.name)).toEqual(["Research dot"]);
  });

  it("lists none while Agents is not connected", async () => {
    connected = false;
    expect((await list()).assistants).toEqual([]);
  });

  it("answers 503 when Rome Cloud cannot be read, so the list is not taken as empty", async () => {
    listing = Promise.reject(new Error("unreachable"));
    listing.catch(() => {});
    expect((await app.request("/assistants")).status).toBe(503);
  });

  it("sends the guardian's line to the assistant and puts it on the chat", async () => {
    const res = await send(DOT, { text: "Summarise today's PRs" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as OutboxMessage).channel).toBe("agents");

    expect(deps.transports.get("agents")!.sentMessages).toMatchObject([
      { chatId: DOT, message: { text: "Summarise today's PRs" } },
    ]);

    const timeline = (await (
      await app.request(`/assistants/${DOT}/messages`)
    ).json()) as TimelinePage;
    expect(timeline.entries).toMatchObject([
      { direction: "outbound", body: "Summarise today's PRs" },
    ]);

    // Its chat moved, so it now sorts first.
    const [first] = (await list()).assistants;
    expect(first).toMatchObject({ agentId: DOT });
    expect(first!.lastMessageAt).not.toBeNull();
  });

  it("clears a delivered send from the outbox when the chat is read", async () => {
    await send(DOT, { text: "Summarise today's PRs" });
    const inFlight = () => deps.outboxRepo.forAccounts([{ platform: "agents", id: DOT }]);
    expect(await inFlight()).toHaveLength(1);

    await app.request(`/assistants/${DOT}/messages`);
    expect(await inFlight()).toEqual([]);
  });

  it("discards a refused send, so the guardian's retry is a new message", async () => {
    rs.spyOn(deps.transports.get("agents")!, "send").mockRejectedValue(new Error("not reachable"));
    const id = crypto.randomUUID();
    const res = await send(DOT, { text: "Are you there?", id });
    expect((await res.json()) as OutboxMessage).toMatchObject({
      state: "failed",
      error: "not reachable",
    });
    expect(await deps.outboxRepo.forAccounts([{ platform: "agents", id: DOT }])).toEqual([]);

    // The same id replays the refusal rather than sending again.
    const replay = (await (
      await send(DOT, { text: "Are you there?", id })
    ).json()) as OutboxMessage;
    expect(replay.state).toBe("failed");
    expect(deps.transports.get("agents")!.send).toHaveBeenCalledOnce();
  });

  it("refuses an address that is not an agent id", async () => {
    expect((await send("Research dot", { text: "hi" })).status).toBe(404);
    expect((await app.request("/assistants/not-an-id/messages")).status).toBe(404);
  });

  it("refuses an empty line", async () => {
    expect((await send(DOT, { text: "  " })).status).toBe(400);
  });
});
