import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { toAgentInboundMessage } from "../connections/integrations/agents.js";
import { PeopleRepository } from "../db/repositories/people.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { persons } from "../db/schema.js";
import type { AgentMessageEnvelope } from "../lib/rome-cloud-agents.js";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../test/helpers.js";
import { AGENTS_GUARDIAN_LINKED_KEY, createAgentsGuardianLink } from "./agents-guardian.js";

/** A message from an agent, by default one of this Rome's own dots. */
function message(
  agentId: string,
  from: Partial<AgentMessageEnvelope["from"]> = {},
): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from: { agentId, name: "atlas", kind: "dot", account: "ouou", sameAccount: true, ...from },
    to: { agentId: "ep-home", name: "home-rome" },
    sentAt: "2026-10-07T09:28:38.000Z",
    text: "17 + 25 = 42.",
    data: null,
    inReplyTo: null,
    hop: 1,
  });
  if (!inbound) throw new Error("the envelope names no sender agent");
  return inbound;
}

const external = { account: "friend", sameAccount: false };

describe("linking same-account agents to the guardian", () => {
  let testDb: TestDb;
  let people: PeopleRepository;
  let settings: SettingsRepository;
  let link: (message: ChannelMessage) => Promise<void>;

  beforeEach(async () => {
    testDb = createTestDb();
    people = new PeopleRepository(testDb.db, identityConnectionKindOf);
    settings = new SettingsRepository(testDb.db);
    testDb.db
      .insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    link = createAgentsGuardianLink({
      peopleRepo: people,
      settingsRepo: settings,
      channel: "agents",
    });
  });
  afterEach(() => testDb.close());

  it("links an agent Cloud marks as in this account, before its first message is read", async () => {
    await link(message("ep-atlas"));

    const person = await people.byAccount({ channel: "agents", channelUserId: "ep-atlas" });
    expect(person?.id).toBe("owner");
    expect(person?.bondLevel).toBe("guardian");
  });

  it("never links another account's agent, even one sharing a name with the guardian's", async () => {
    await link(message("ep-atlas"));
    await link(message("ep-friend-atlas", external));

    expect((await people.byAccount({ channel: "agents", channelUserId: "ep-atlas" }))?.id).toBe(
      "owner",
    );
    expect(
      await people.byAccount({ channel: "agents", channelUserId: "ep-friend-atlas" }),
    ).toBeNull();
    expect(await settings.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)).toEqual(["ep-atlas"]);
  });

  it("keeps a dismissal", async () => {
    await people.dismiss({ channel: "agents", channelUserId: "ep-atlas" });

    await link(message("ep-atlas"));

    expect(await people.byAccount({ channel: "agents", channelUserId: "ep-atlas" })).toBeNull();
    expect(await people.isDismissed({ channel: "agents", channelUserId: "ep-atlas" })).toBe(true);
  });

  it("keeps a link to another person", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "ada", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() })
      .run();
    await people.linkStated({ channel: "agents", channelUserId: "ep-atlas" }, "ada");

    await link(message("ep-atlas"));

    expect((await people.byAccount({ channel: "agents", channelUserId: "ep-atlas" }))?.id).toBe(
      "ada",
    );
  });

  it("does not link again an agent the guardian unlinked, even renamed", async () => {
    await link(message("ep-atlas"));
    expect(await people.unlink({ channel: "agents", channelUserId: "ep-atlas" }, "owner")).toBe(
      true,
    );

    await link(message("ep-atlas", { name: "nova" }));

    expect(await people.byAccount({ channel: "agents", channelUserId: "ep-atlas" })).toBeNull();
  });

  it("links a new agent that takes the name of one the guardian unlinked", async () => {
    await link(message("ep-atlas"));
    await people.unlink({ channel: "agents", channelUserId: "ep-atlas" }, "owner");

    await link(message("ep-atlas-2"));

    expect((await people.byAccount({ channel: "agents", channelUserId: "ep-atlas-2" }))?.id).toBe(
      "owner",
    );
  });

  it("records every agent when several first messages arrive at once", async () => {
    await Promise.all(["ep-atlas", "ep-muse", "ep-nova"].map((id) => link(message(id))));

    expect([...((await settings.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [])].sort()).toEqual([
      "ep-atlas",
      "ep-muse",
      "ep-nova",
    ]);
  });
});
