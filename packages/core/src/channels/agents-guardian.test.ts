import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { InboundMessage } from "../connections/types.js";
import { toAgentInboundMessage } from "../connections/integrations/agents.js";
import { ensureSentinelPersons } from "../db/ensure-sentinel-persons.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { persons } from "../db/schema.js";
import type { AgentMessageEnvelope } from "../lib/rome-cloud-agents.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { AGENTS_GUARDIAN_LINKED_KEY, createAgentsGuardianLink } from "./agents-guardian.js";

function message(from: AgentMessageEnvelope["from"]): InboundMessage {
  return toAgentInboundMessage({
    messageId: "msg_1",
    from,
    to: { endpoint: "home-rome" },
    sentAt: "2026-10-07T09:28:38.000Z",
    text: "17 + 25 = 42.",
    data: null,
    inReplyTo: null,
    hop: 1,
  });
}

describe("linking same-account agents to the guardian", () => {
  let testDb: TestDb;
  let people: PersonMappingRepository;
  let settings: SettingsRepository;
  let link: (message: InboundMessage) => Promise<void>;

  beforeEach(async () => {
    testDb = createTestDb();
    people = new PersonMappingRepository(testDb.db);
    settings = new SettingsRepository(testDb.db);
    await ensureSentinelPersons(people);
    testDb.db
      .insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    link = createAgentsGuardianLink({
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
    });
  });
  afterEach(() => testDb.close());

  it("links an endpoint Cloud marks as in this account, before its first message is read", async () => {
    await link(message({ endpoint: "atlas", kind: "dot", sameAccount: true }));

    const person = await people.findByChannelUser("agents", "atlas");
    expect(person?.id).toBe("owner");
    expect(person?.bondLevel).toBe("guardian");
  });

  it("leaves a sender unlinked when Cloud does not say it is in this account", async () => {
    await link(message({ endpoint: "atlas", kind: "dot" }));
    await link(message({ endpoint: "muse", kind: "dot", sameAccount: false }));

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
    expect(await people.findByChannelUser("agents", "muse")).toBeNull();
  });

  it("keeps a dismissal", async () => {
    await people.addChannelMapping(STRANGER_PERSON_ID, "agents", "atlas");

    await link(message({ endpoint: "atlas", kind: "dot", sameAccount: true }));

    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe(STRANGER_PERSON_ID);
  });

  it("keeps a link to another person", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "ada", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() })
      .run();
    await people.addChannelMapping("ada", "agents", "atlas");

    await link(message({ endpoint: "atlas", kind: "dot", sameAccount: true }));

    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("does not link again an endpoint the guardian unlinked", async () => {
    const atlas = message({ endpoint: "atlas", kind: "dot", sameAccount: true });
    await link(atlas);
    expect(await people.unlinkAccount("owner", "agents", "atlas")).toBe(true);

    await link(atlas);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("records every endpoint when several first messages arrive at once", async () => {
    await Promise.all(
      ["atlas", "muse", "nova"].map((endpoint) =>
        link(message({ endpoint, kind: "dot", sameAccount: true })),
      ),
    );

    expect([...((await settings.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [])].sort()).toEqual([
      "atlas",
      "muse",
      "nova",
    ]);
  });
});
