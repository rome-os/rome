import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { toAgentInboundMessage } from "../connections/integrations/agents.js";
import { ensureSentinelPersons } from "../db/ensure-sentinel-persons.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { persons } from "../db/schema.js";
import type { AgentMessageEnvelope } from "../lib/rome-cloud-agents.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { AGENTS_GUARDIAN_LINKED_KEY, createAgentsGuardianLink } from "./agents-guardian.js";
import {
  AGENTS_ENDPOINT_ADDRESSES_KEY,
  type AgentsIdentity,
  agentSightings,
  createAgentsIdentity,
} from "./agents-identity.js";

function message(from: AgentMessageEnvelope["from"]): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from,
    to: { endpoint: "home-rome" },
    sentAt: "2026-10-08T09:28:38.000Z",
    text: "Hello",
    data: null,
    inReplyTo: null,
    hop: 0,
  });
  if (!inbound) throw new Error("the envelope names no sender account");
  return inbound;
}

describe("keeping agents' links on their endpoint", () => {
  let testDb: TestDb;
  let people: PersonMappingRepository;
  let settings: SettingsRepository;
  let identity: AgentsIdentity;

  beforeEach(async () => {
    testDb = createTestDb();
    people = new PersonMappingRepository(testDb.db);
    settings = new SettingsRepository(testDb.db);
    await ensureSentinelPersons(people);
    testDb.db
      .insert(persons)
      .values([
        { id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() },
        { id: "ada", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() },
      ])
      .run();
    identity = createAgentsIdentity({
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
    });
  });
  afterEach(() => testDb.close());

  it("moves a linked agent's link to its new address when its owner renames their handle", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([{ endpointId: "ep_atlas", address: "@friend/atlas" }]);

    await identity.observe([{ endpointId: "ep_atlas", address: "@newfriend/atlas" }]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
    expect(await settings.get(AGENTS_ENDPOINT_ADDRESSES_KEY)).toEqual({
      ep_atlas: "@newfriend/atlas",
    });
  });

  it("drops the old link when a new endpoint reuses a removed one's name", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observe([{ endpointId: "ep_old", address: "atlas" }]);

    await identity.observe([{ endpointId: "ep_new", address: "atlas" }]);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
    expect(await settings.get(AGENTS_ENDPOINT_ADDRESSES_KEY)).toEqual({ ep_new: "atlas" });
  });

  it("lets an endpoint first seen keep the link its address already has", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");

    await identity.observe([{ endpointId: "ep_atlas", address: "atlas" }]);
    await identity.observe([{ endpointId: "ep_atlas", address: "atlas" }]);

    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("takes the endpoint id from an inbound message, and none from an older Cloud", () => {
    expect(
      agentSightings(message({ endpoint: "atlas", endpointId: "ep_atlas", kind: "dot" })),
    ).toEqual([{ endpointId: "ep_atlas", address: "atlas" }]);
    expect(agentSightings(message({ endpoint: "atlas", kind: "dot" }))).toEqual([]);
    expect(agentSightings(message({ endpoint: "atlas", endpointId: null, kind: "dot" }))).toEqual(
      [],
    );
  });

  describe("with the guardian link", () => {
    let link: (message: ChannelMessage) => Promise<void>;
    const own = (endpointId: string) =>
      message({ endpoint: "atlas", endpointId, kind: "dot", sameAccount: true });
    const admit = async (inbound: ChannelMessage) => {
      await identity.observe(agentSightings(inbound));
      await link(inbound);
    };

    beforeEach(() => {
      link = createAgentsGuardianLink({
        personMappingRepo: people,
        settingsRepo: settings,
        channel: "agents",
        serial: identity.serial,
      });
    });

    it("records the endpoint, so the guardian's unlink holds and a reused name is linked anew", async () => {
      await admit(own("ep_old"));
      expect(await settings.get(AGENTS_GUARDIAN_LINKED_KEY)).toEqual(["ep_old"]);
      expect(await people.unlinkAccount("owner", "agents", "atlas")).toBe(true);

      await admit(own("ep_old"));
      expect(await people.findByChannelUser("agents", "atlas")).toBeNull();

      await admit(own("ep_new"));
      expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("owner");
    });

    it("moves a record made by name onto the endpoint first seen under it", async () => {
      await settings.set(AGENTS_GUARDIAN_LINKED_KEY, ["atlas"]);

      await admit(own("ep_atlas"));

      expect(await settings.get(AGENTS_GUARDIAN_LINKED_KEY)).toEqual(["ep_atlas"]);
      expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
    });

    it("never links another account's agent that takes a name this Rome knew", async () => {
      await admit(own("ep_atlas"));

      await admit(
        message({
          endpoint: "@friend/atlas",
          endpointId: "ep_friend",
          kind: "dot",
          sameAccount: false,
          account: "friend",
        }),
      );

      expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("owner");
      expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
    });
  });
});
