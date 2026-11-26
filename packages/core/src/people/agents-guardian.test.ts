import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { channelMessageOf } from "../chats/connected-accounts/channel-message.js";
import { toAgentInboundMessage } from "../connections/integrations/agents.js";
import { DrizzlePeopleRepository } from "./infrastructure/drizzle-people-repository.js";
import type { PeopleRepository } from "./model/people-repository.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { persons } from "../db/schema.js";
import type { AgentMessageEnvelope } from "../connections/integrations/rome-cloud-agents.js";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../test/db.js";
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
  return channelMessageOf(inbound, "agents");
}

const external = { account: "friend", sameAccount: false };

describe("same-account agents acting for the guardian", () => {
  let testDb: TestDb;
  let people: PeopleRepository;
  let settings: SettingsRepository;
  let link: (message: ChannelMessage) => Promise<void>;
  /** The accounts Access was told act for the guardian. */
  let acting: Set<string>;

  beforeEach(async () => {
    testDb = createTestDb();
    people = new DrizzlePeopleRepository(testDb.db);
    acting = new Set();
    settings = new SettingsRepository(testDb.db);
    testDb.db
      .insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    link = createAgentsGuardianLink({
      peopleRepo: people,
      settingsRepo: settings,
      platform: "agents",
      startedActingForGuardian: ({ platform, id }) => acting.add(`${platform}:${id}`),
    });
  });
  afterEach(() => testDb.close());

  const acts = (id: string) => acting.has(`agents:${id}`);

  it("links an agent Cloud marks as in this account, before its first message is read", async () => {
    await link(message("ep-atlas"));

    const person = await people.byAccount({ platform: "agents", id: "ep-atlas" });
    expect(person?.id).toBe("owner");
    expect(person?.bondLevel).toBe("guardian");
    // A delegate link: the guardian's agent, not the guardian.
    expect(person?.links).toEqual([{ platform: "agents", id: "ep-atlas", delegate: true }]);
    expect(acts("ep-atlas")).toBe(true);
  });

  it("never links another account's agent, even one sharing a name with the guardian's", async () => {
    await link(message("ep-atlas"));
    await link(message("ep-friend-atlas", external));

    expect((await people.byAccount({ platform: "agents", id: "ep-atlas" }))?.id).toBe("owner");
    expect(await people.byAccount({ platform: "agents", id: "ep-friend-atlas" })).toBeNull();
    expect(await settings.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)).toEqual(["ep-atlas"]);
    expect(acts("ep-friend-atlas")).toBe(false);
  });

  it("keeps a dismissal", async () => {
    await people.dismiss({ platform: "agents", id: "ep-atlas" });

    await link(message("ep-atlas"));

    expect(await people.byAccount({ platform: "agents", id: "ep-atlas" })).toBeNull();
    expect(await people.isDismissed({ platform: "agents", id: "ep-atlas" })).toBe(true);
    expect(acts("ep-atlas")).toBe(false);
  });

  it("keeps a link to another person", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "ada", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() })
      .run();
    await people.linkStated({ platform: "agents", id: "ep-atlas" }, "ada");

    await link(message("ep-atlas"));

    expect((await people.byAccount({ platform: "agents", id: "ep-atlas" }))?.id).toBe("ada");
    expect(acts("ep-atlas")).toBe(false);
  });

  it("does not link again an agent the guardian unlinked, even renamed", async () => {
    await link(message("ep-atlas"));
    expect(await people.unlink({ platform: "agents", id: "ep-atlas" }, "owner")).toBe(true);
    acting.clear();

    await link(message("ep-atlas", { name: "nova" }));

    expect(await people.byAccount({ platform: "agents", id: "ep-atlas" })).toBeNull();
    expect(acts("ep-atlas")).toBe(false);
  });

  it("links a new agent that takes the name of one the guardian unlinked", async () => {
    await link(message("ep-atlas"));
    await people.unlink({ platform: "agents", id: "ep-atlas" }, "owner");

    await link(message("ep-atlas-2"));

    expect((await people.byAccount({ platform: "agents", id: "ep-atlas-2" }))?.id).toBe("owner");
    expect(acts("ep-atlas-2")).toBe(true);
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
