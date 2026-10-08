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
  AGENTS_ENDPOINTS_KEY,
  type AgentSighting,
  type AgentsIdentity,
  agentSightings,
  createAgentsIdentity,
} from "./agents-identity.js";

const SENT = Date.parse("2026-10-08T09:28:38.000Z");

function message(from: AgentMessageEnvelope["from"], sentAt = SENT): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from,
    to: { endpoint: "home-rome" },
    sentAt: new Date(sentAt).toISOString(),
    text: "Hello",
    data: null,
    inReplyTo: null,
    hop: 0,
  });
  if (!inbound) throw new Error("the envelope names no sender account");
  return inbound;
}

/** A creation time before any link the test sets aside, since Rome keeps it to
 *  the second. */
const earlier = () => new Date(Date.now() - 60_000);

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
        { id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: earlier() },
        { id: "ada", displayName: "Ada", bondLevel: "acquaintance", createdAt: earlier() },
      ])
      .run();
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
    });
  });
  afterEach(() => testDb.close());

  const listed = (endpointId: string, address: string): AgentSighting => ({
    endpointId,
    address,
    by: "listing",
  });
  const sent = (endpointId: string, address: string, at: number): AgentSighting => ({
    endpointId,
    address,
    by: "message",
    at,
  });

  it("moves a linked agent's link to its new address when its owner renames their handle", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas", "@friend/atlas (atlas dot)");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);

    await identity.observe([listed("ep_atlas", "@newfriend/atlas")]);

    expect(people.readChannelHolder(testDb.db, "agents", "@newfriend/atlas")).toEqual({
      personId: "ada",
      displayName: "@newfriend/atlas (atlas dot)",
    });
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
    expect(await settings.get(AGENTS_ENDPOINTS_KEY)).toEqual({
      ep_atlas: { address: "@newfriend/atlas", by: "listing", listedAt: 0 },
    });
  });

  it("starts a new endpoint that reuses a removed one's name unlinked", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observe([listed("ep_old", "atlas")]);

    await identity.observe([listed("ep_new", "atlas")]);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
    // A link made for the new endpoint stays, whatever it is seen by next.
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observe([listed("ep_new", "atlas")]);
    await identity.observe([sent("ep_new", "atlas", 3)]);
    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("lets no message take an address from the endpoint a listing put there", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observe([listed("ep_old", "atlas")]);

    await identity.observe([sent("ep_new", "atlas", Date.now() + 60_000)]);

    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("gives a set-aside link back to its endpoint when it shows up renamed", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);
    // The friend's old handle went to someone else before Rome saw the rename.
    await identity.observe([listed("ep_other", "@friend/atlas")]);

    await identity.observe([listed("ep_atlas", "@newfriend/atlas")]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
  });

  it("settles a rename before a new endpoint taking the old address, whatever the listing order", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);

    await identity.observe([
      listed("ep_other", "@friend/atlas"),
      listed("ep_atlas", "@newfriend/atlas"),
    ]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
  });

  it("lets no held-back message undo what a listing settled", async () => {
    await people.addChannelMapping("ada", "agents", "@newfriend/atlas");
    await identity.observe([
      listed("ep_atlas", "@newfriend/atlas"),
      listed("ep_other", "@friend/atlas"),
    ]);
    await people.addChannelMapping("owner", "agents", "@friend/atlas");

    await identity.observe([sent("ep_atlas", "@friend/atlas", Date.now() + 60_000)]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect((await people.findByChannelUser("agents", "@friend/atlas"))?.id).toBe("owner");
  });

  it("asks Cloud again when a message disagrees with a listing, so a rename reaches its person at once", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    let listing = [listed("ep_atlas", "@friend/atlas")];
    const asked = { count: 0 };
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => {
        asked.count++;
        return listing;
      },
    });
    await identity.observeListing(listing, 0);
    listing = [listed("ep_atlas", "@newfriend/atlas")];

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 1)]);

    expect(asked.count).toBe(1);
    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    // A message that agrees with what the listing says asks nothing.
    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 2)]);
    expect(asked.count).toBe(1);
  });

  it("reads Cloud once a half minute for the same disagreement, and at once for a new one", async () => {
    await people.addChannelMapping("ada", "agents", "@newfriend/atlas");
    let clock = 0;
    const asked = { count: 0 };
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      now: () => clock,
      list: async () => {
        asked.count++;
        return [listed("ep_atlas", "@newfriend/atlas")];
      },
    });
    await identity.observeListing([listed("ep_atlas", "@newfriend/atlas")], clock);

    // A People page read just before a rename does not hold its first message back.
    clock = 1_000;
    await identity.observe([sent("ep_atlas", "@friend/atlas", 1)]);
    await identity.observe([sent("ep_atlas", "@friend/atlas", 2)]);
    expect(asked.count).toBe(1);
    clock = 2_000;
    await identity.observe([sent("ep_atlas", "@other/atlas", 3)]);
    expect(asked.count).toBe(2);
    clock = 31_000;
    await identity.observe([sent("ep_atlas", "@friend/atlas", 4)]);
    await identity.observe([sent("ep_atlas", "@friend/atlas", 5)]);
    expect(asked.count).toBe(3);
    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("lets no listing settle after one asked for later", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);

    await identity.observeListing([listed("ep_atlas", "@newfriend/atlas")], 2);
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 1);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
  });

  it("lets a message wait only so long for Cloud, and settles the listing when it comes", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    let answer: (listing: AgentSighting[] | null) => void = () => {};
    let asked = 0;
    let clock = Date.now();
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      relistWaitMs: 10,
      now: () => clock,
      list: () => {
        asked++;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 0);

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 1)]);
    expect(await people.findByChannelUser("agents", "@newfriend/atlas")).toBeNull();

    // A read that fails leaves the disagreement free to be listed again, once
    // Cloud has had a while to come back.
    answer(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 2)]);
    expect(asked).toBe(1);
    clock += 30_000;
    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 3)]);
    expect(asked).toBe(2);
    answer([listed("ep_atlas", "@newfriend/atlas")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await identity.serial(async () => {});
    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("takes a link off a reused name while no listing can answer, and gives it back if it still holds", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => null,
    });
    await identity.observeListing([listed("ep_old", "atlas")], 1);

    await identity.observe([sent("ep_new", "atlas", 5)]);
    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();

    await identity.observeListing([listed("ep_old", "atlas")], 2);
    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("keeps an unlisted endpoint's own messages ordered against the listing", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => [],
    });
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 1);
    await identity.observeListing([listed("ep_atlas", "@newfriend/atlas")], 2);
    await identity.observeListing([listed("ep_else", "nova")], 3);

    await identity.observe([sent("ep_atlas", "@friend/atlas", 1)]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("follows an unlisted endpoint through a rename its newer messages say", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => [],
    });
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 1);
    await identity.observe([sent("ep_atlas", "@friend/atlas", 5)]);
    await identity.observeListing([listed("ep_else", "nova")], 2);

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 4)]);
    expect((await people.findByChannelUser("agents", "@friend/atlas"))?.id).toBe("ada");

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 6)]);
    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("lets a reused name take an unlisted endpoint's address whatever Rome's clock says", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observeListing([listed("ep_old", "atlas")], Date.now() + 3_600_000);
    await identity.observeListing([listed("ep_else", "nova")], Date.now() + 3_600_001);

    await identity.observe([sent("ep_new", "atlas", Date.now())]);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("lets no listing asked for before a message moved an endpoint move it back", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    let clock = Date.now();
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      now: () => clock,
    });
    await identity.observe([sent("ep_atlas", "@friend/atlas", 1)]);
    const askedAt = clock;
    clock += 1_000;
    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 2)]);

    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], askedAt);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("stops waiting on Cloud for a while once a read hangs", async () => {
    let asked = 0;
    let clock = Date.now();
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      relistWaitMs: 10,
      now: () => clock,
      list: () => {
        asked++;
        return new Promise(() => {});
      },
    });

    await identity.observe([sent("ep_atlas", "atlas", 1)]);
    await identity.observe([sent("ep_atlas", "atlas", 2)]);
    expect(asked).toBe(1);

    clock += 30_000;
    await identity.observe([sent("ep_atlas", "atlas", 3)]);
    expect(asked).toBe(1);
    expect(settings.read(testDb.db, AGENTS_ENDPOINTS_KEY)).toMatchObject({
      ep_atlas: { address: "atlas", at: 3 },
    });
  });

  it("reads Cloud once at boot, so a rename before the next message still moves the link", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    let listing = [listed("ep_atlas", "@friend/atlas")];
    let asked = 0;
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => {
        asked++;
        return listing;
      },
    });
    await identity.prime();
    listing = [listed("ep_atlas", "@newfriend/atlas")];

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 1)]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    // Primed once: the message's own read is for its disagreement.
    expect(asked).toBe(2);
  });

  it("starts one read for a disagreement however many messages wait on it", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    let asked = 0;
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      relistWaitMs: 5,
      list: () => {
        asked++;
        return new Promise(() => {});
      },
    });
    await identity.observeListing([listed("ep_old", "atlas")], 0);

    await identity.observe([sent("ep_new", "atlas", 1)]);
    await identity.observe([sent("ep_new", "atlas", 2)]);

    expect(asked).toBe(1);
    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("reads a disputed message again once a listing stops vouching for its address", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => [listed("ep_else", "nova")],
    });
    await identity.observeListing([listed("ep_old", "atlas")], 0);

    await identity.observe([sent("ep_new", "atlas", 5)]);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("reads a held message again against a newer listing that settled while it waited", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    let clock = 10;
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      now: () => clock,
      relistWaitMs: 20,
      list: () => new Promise(() => {}),
    });
    await identity.observeListing([listed("ep_old", "atlas")], 0);

    const message = identity.observe([sent("ep_new", "atlas", 5)]);
    clock = 20;
    await identity.observeListing([listed("ep_else", "nova")], 20);
    await message;

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("lists Cloud again for no message from an endpoint the listing left out", async () => {
    let asked = 0;
    identity = createAgentsIdentity({
      db: testDb.db,
      personMappingRepo: people,
      settingsRepo: settings,
      channel: "agents",
      list: async () => {
        asked++;
        return [];
      },
    });
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 0);
    await identity.observeListing([listed("ep_else", "nova")], 1);

    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 1)]);

    expect(asked).toBe(0);
  });

  it("orders messages by when they were sent", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([sent("ep_atlas", "@friend/atlas", 1)]);
    await identity.observe([sent("ep_atlas", "@newfriend/atlas", 3)]);

    await identity.observe([sent("ep_atlas", "@friend/atlas", 2)]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
  });

  it("never carries a link between this Rome's own account and another", async () => {
    await people.addChannelMapping("owner", "agents", "atlas");
    await identity.observe([listed("ep_atlas", "atlas")]);

    await identity.observe([listed("ep_atlas", "@other/atlas")]);

    expect(await people.findByChannelUser("agents", "@other/atlas")).toBeNull();
    // It stops waiting, since it can never go back.
    expect(await settings.get(AGENTS_ENDPOINTS_KEY)).toEqual({
      ep_atlas: { address: "@other/atlas", by: "listing", listedAt: 0 },
    });
    // Nor does it stay behind for the next endpoint to take the name.
    await identity.observe([listed("ep_new", "atlas")]);
    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("never gives a set-aside link back across accounts", async () => {
    await people.addChannelMapping("owner", "agents", "atlas");
    await identity.observe([listed("ep_atlas", "atlas")]);
    await identity.observe([listed("ep_other", "atlas")]);

    await identity.observe([listed("ep_atlas", "@other/atlas")]);

    expect(await people.findByChannelUser("agents", "@other/atlas")).toBeNull();
  });

  it("changes nothing when a settlement fails partway, so the next one settles it whole", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);
    const before = await settings.get(AGENTS_ENDPOINTS_KEY);
    const writeChannelMapping = people.writeChannelMapping.bind(people);
    people.writeChannelMapping = () => {
      throw new Error("disk full");
    };
    await identity.observe([listed("ep_atlas", "@newfriend/atlas")]);
    people.writeChannelMapping = writeChannelMapping;
    expect((await people.findByChannelUser("agents", "@friend/atlas"))?.id).toBe("ada");
    expect(await settings.get(AGENTS_ENDPOINTS_KEY)).toEqual(before);

    await identity.observe([listed("ep_atlas", "@newfriend/atlas")]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("ada");
    expect(await people.findByChannelUser("agents", "@friend/atlas")).toBeNull();
  });

  it("drops a waiting link whose person has since been merged away", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "ada2", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() })
      .run();
    await people.addChannelMapping("ada2", "agents", "@friend/atlas");
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 1);
    await identity.observeListing([listed("ep_other", "@friend/atlas")], 2);
    expect(await people.mergePersons("ada", "ada2")).toMatchObject({ merged: true });

    await identity.observeListing(
      [listed("ep_other", "@friend/atlas"), listed("ep_atlas", "@newfriend/atlas")],
      3,
    );

    expect(await people.findByChannelUser("agents", "@newfriend/atlas")).toBeNull();
    expect(await settings.get(AGENTS_ENDPOINTS_KEY)).toEqual({
      ep_atlas: { address: "@newfriend/atlas", by: "listing", listedAt: 3 },
      ep_other: { address: "@friend/atlas", by: "listing", listedAt: 3 },
    });
  });

  it("never gives a waiting link to a new person who took a merged person's id", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "ada2", displayName: "Ada", bondLevel: "acquaintance", createdAt: new Date() })
      .run();
    await people.addChannelMapping("ada2", "agents", "@friend/atlas");
    await identity.observeListing([listed("ep_atlas", "@friend/atlas")], 1);
    await identity.observeListing([listed("ep_other", "@friend/atlas")], 2);
    await people.mergePersons("ada", "ada2");
    testDb.db
      .insert(persons)
      .values({
        id: "ada2",
        displayName: "Another Ada",
        bondLevel: "inner-circle",
        createdAt: new Date(Date.now() + 60_000),
      })
      .run();

    await identity.observeListing(
      [listed("ep_other", "@friend/atlas"), listed("ep_atlas", "@newfriend/atlas")],
      3,
    );

    expect(await people.findByChannelUser("agents", "@newfriend/atlas")).toBeNull();
  });

  it("lets a message take an address from an endpoint the listing no longer names", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");
    await identity.observeListing([listed("ep_old", "atlas")], 1);
    await identity.observeListing([listed("ep_else", "nova")], 2);

    await identity.observe([sent("ep_new", "atlas", 5)]);

    expect(await people.findByChannelUser("agents", "atlas")).toBeNull();
  });

  it("keeps a decision made about the new address over a link waiting for it", async () => {
    await people.addChannelMapping("ada", "agents", "@friend/atlas");
    await identity.observe([listed("ep_atlas", "@friend/atlas")]);
    await identity.observe([listed("ep_other", "@friend/atlas")]);
    await people.addChannelMapping("owner", "agents", "@newfriend/atlas");

    await identity.observe([listed("ep_atlas", "@newfriend/atlas")]);

    expect((await people.findByChannelUser("agents", "@newfriend/atlas"))?.id).toBe("owner");
  });

  it("lets an endpoint first seen keep the link its address already has", async () => {
    await people.addChannelMapping("ada", "agents", "atlas");

    await identity.observe([listed("ep_atlas", "atlas")]);
    await identity.observe([sent("ep_atlas", "atlas", 2)]);

    expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("ada");
  });

  it("takes the endpoint id from an inbound message, and none from a removed endpoint", () => {
    expect(
      agentSightings(message({ endpoint: "atlas", endpointId: "ep_atlas", kind: "dot" })),
    ).toEqual([{ endpointId: "ep_atlas", address: "atlas", by: "message", at: SENT }]);
    expect(agentSightings(message({ endpoint: "atlas", endpointId: null, kind: "dot" }))).toEqual(
      [],
    );
  });

  describe("with the guardian link", () => {
    let link: (message: ChannelMessage) => Promise<void>;
    const own = (endpointId: string, sentAt = SENT) =>
      message({ endpoint: "atlas", endpointId, kind: "dot", sameAccount: true }, sentAt);
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

      await admit(own("ep_new", SENT + 1));
      expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("owner");
      await admit(own("ep_new", SENT + 2));
      expect((await people.findByChannelUser("agents", "atlas"))?.id).toBe("owner");
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
