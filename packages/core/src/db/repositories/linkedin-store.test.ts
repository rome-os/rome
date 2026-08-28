import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { LinkedInStoreRepository, linkedInMemberIdFromProfileUrl } from "./linkedin-store.js";
import { PersonMappingRepository } from "./person-mapping.js";

describe("LinkedInStoreRepository", () => {
  let testDb: TestDb;
  let repo: LinkedInStoreRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new LinkedInStoreRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  const thread = (threadId: string, at: Date) => ({
    threadId,
    threadUrl: `https://www.linkedin.com/messaging/thread/${threadId}/`,
    personName: "Ada Lovelace",
    lastMessagePreview: "See you Sunday?",
    lastMessageAt: at,
    unread: true,
    counterpartyType: "member",
    category: "INBOX,PRIMARY_INBOX",
  });

  it("upserts threads and reads back watermarks", async () => {
    const at = new Date("2026-08-19T20:00:00Z");
    await repo.upsertThreads([thread("t1", at)]);

    const cursors = await repo.getThreadCursors(["t1", "missing"]);
    expect(cursors.size).toBe(1);
    const cursor = cursors.get("t1");
    expect(cursor?.lastMessageAt?.getTime()).toBe(at.getTime());
    expect(cursor?.lastMessagePreview).toBe("See you Sunday?");
    expect(cursor?.lastSyncedAt).toBeNull();
  });

  it("a re-listed thread keeps learned fields when the listing drops them", async () => {
    const at = new Date("2026-08-19T20:00:00Z");
    await repo.upsertThreads([thread("t1", at)]);
    await repo.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: null,
        lastMessagePreview: null,
        lastMessageAt: null,
        unread: false,
      },
    ]);

    const cursor = (await repo.getThreadCursors(["t1"])).get("t1");
    expect(cursor?.lastMessagePreview).toBe("See you Sunday?");
    expect(cursor?.lastMessageAt?.getTime()).toBe(at.getTime());
  });

  // The group flag is read through what it decides rather than read back as a
  // field: a thread LinkedIn calls a group is not one of its members' direct
  // threads, so its messages stop counting towards that member. That is the
  // whole reason the poller stores the flag, and the only reader left.
  const memberOf = async (participantId: string) =>
    (await repo.listParticipants()).find((row) => row.participantId === participantId);

  /** One mirrored 1:1 thread with a single message on it. */
  const seedDirectThread = async (threadId: string) => {
    await repo.upsertThreads([thread(threadId, new Date("2026-08-19T20:00:00Z"))]);
    await repo.upsertThreadParticipants(threadId, [
      { participantId: "ACoAAAda0001", name: "Ada Lovelace", isSelf: false },
      { participantId: "ACoAASelf001", name: "Guardian", isSelf: true },
    ]);
    await repo.upsertMessages([
      {
        messageId: `${threadId}-m1`,
        threadId,
        sentAt: new Date("2026-08-19T19:00:00Z"),
        senderName: "Ada Lovelace",
        senderProfileUrl: null,
        senderHeadline: null,
        senderType: "member",
        senderIsSelf: false,
        text: "See you Sunday?",
        subject: null,
        reactionCount: null,
      },
    ]);
  };

  it("markThreadSynced advances the watermark and records the group flag", async () => {
    await seedDirectThread("t1");
    expect((await memberOf("ACoAAAda0001"))?.messageCount).toBe(1);

    await repo.markThreadSynced("t1", {
      conversationTitle: "Weekend plans",
      isGroup: true,
    });

    expect((await repo.getThreadCursors(["t1"])).get("t1")?.lastSyncedAt).not.toBeNull();
    // The snapshot said "group", so the thread stops being Ada's history.
    expect((await memberOf("ACoAAAda0001"))?.messageCount).toBe(0);
  });

  it("null snapshot metadata never clears what an earlier snapshot learned", async () => {
    await seedDirectThread("t1");
    await repo.markThreadSynced("t1", { conversationTitle: "Weekend plans", isGroup: true });
    // A later snapshot from an older plugin reports nothing.
    await repo.markThreadSynced("t1", { conversationTitle: null, isGroup: null });

    // Still a group. A null that overwrote would silently hand nine other
    // people's words back to Ada.
    expect((await memberOf("ACoAAAda0001"))?.messageCount).toBe(0);
  });

  it("a never-snapshotted thread is unknown rather than a group", async () => {
    await seedDirectThread("t1");
    // No snapshot has run, so the flag is null — and null is not a group, or a
    // thread would be withheld from its own counterparty until one did.
    expect((await repo.getThreadCursors(["t1"])).get("t1")?.lastSyncedAt).toBeNull();
    expect((await memberOf("ACoAAAda0001"))?.messageCount).toBe(1);
  });

  it("message upsert is idempotent and refreshes mutable fields", async () => {
    await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
    const base = {
      messageId: "m1",
      threadId: "t1",
      sentAt: new Date("2026-08-19T19:00:00Z"),
      senderName: "Ada Lovelace",
      senderProfileUrl: "https://www.linkedin.com/in/ada/",
      senderHeadline: "Engineer",
      senderType: "member",
      senderIsSelf: false,
      text: "See you Sunday?",
      subject: null,
      reactionCount: null,
    };
    await repo.upsertMessages([base]);
    // The same message re-snapshotted later: an edit and a new reaction.
    await repo.upsertMessages([{ ...base, text: "See you Sunday at 7?", reactionCount: 2 }]);

    const history = await repo.fetchHistory("t1", new Date(0));
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe("See you Sunday at 7?");
  });

  it("fetchHistory scopes by thread, filters by since, and orders chronologically", async () => {
    await repo.upsertThreads([
      thread("t1", new Date("2026-08-19T20:00:00Z")),
      thread("t2", new Date("2026-08-19T20:00:00Z")),
    ]);
    const msg = (threadId: string, messageId: string, iso: string, text: string) => ({
      messageId,
      threadId,
      sentAt: new Date(iso),
      senderName: "Ada Lovelace",
      senderProfileUrl: null,
      senderHeadline: null,
      senderType: "member",
      senderIsSelf: false,
      text,
      subject: null,
      reactionCount: null,
    });
    await repo.upsertMessages([
      msg("t1", "m-old", "2026-08-10T10:00:00Z", "old"),
      msg("t1", "m-new", "2026-08-19T10:00:00Z", "new"),
      msg("t2", "m-other", "2026-08-19T11:00:00Z", "other thread"),
    ]);

    const all = await repo.fetchHistory(null, new Date("2026-08-01T00:00:00Z"));
    expect(all.map((m) => m.messageId)).toEqual(["m-old", "m-new", "m-other"]);

    const recentT1 = await repo.fetchHistory("t1", new Date("2026-08-15T00:00:00Z"));
    expect(recentT1.map((m) => m.messageId)).toEqual(["m-new"]);
    expect(recentT1[0].threadName).toBe("Ada Lovelace");
  });

  describe("thread participants", () => {
    const ada = {
      participantId: "ACoAAAda0001",
      name: "Ada Lovelace",
      headline: "Engineer",
      type: "member",
      isSelf: false,
    };
    const grace = {
      participantId: "ACoAAGrace002",
      name: "Grace Hopper",
      headline: "Rear Admiral",
      type: "member",
      isSelf: false,
    };
    const self = {
      participantId: "ACoAASelf0003",
      name: "Me Myself",
      headline: null,
      type: "member",
      isSelf: true,
    };

    // createTestDb applies the real migration folder, so reaching these tables
    // at all proves the generated migration created them.
    it("the migrations create both tables and the participant_id index", () => {
      const objects = testDb.db.all(sql`
        SELECT name, type FROM sqlite_master
        WHERE name IN (
          'linkedin_participants',
          'linkedin_thread_participants',
          'idx_linkedin_thread_participants_participant'
        )
      `) as Array<{ name: string; type: string }>;
      const byName = new Map(objects.map((o) => [o.name, o.type]));

      expect(byName.get("linkedin_participants")).toBe("table");
      expect(byName.get("linkedin_thread_participants")).toBe("table");
      expect(byName.get("idx_linkedin_thread_participants_participant")).toBe("index");
    });

    it("the migrations add the per-thread membership read timestamp", () => {
      const columns = testDb.db.all(
        sql`SELECT name FROM pragma_table_info('linkedin_threads')`,
      ) as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("participants_last_read_at");
    });

    it("upserting the same participant set twice leaves one row per participant", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);

      const participants = await repo.getThreadParticipants("t1");
      expect(participants.map((p) => p.participantId)).toEqual([
        ada.participantId,
        grace.participantId,
        self.participantId,
      ]);

      // Person-level facts are stored once, not once per thread.
      const personRows = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants
      `) as Array<{ c: number }>;
      expect(Number(personRows[0].c)).toBe(3);
    });

    it("upserting a smaller set for a thread drops the members that are gone", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);
      await repo.upsertThreadParticipants("t1", [ada, self]);

      const participants = await repo.getThreadParticipants("t1");
      expect(participants.map((p) => p.participantId)).toEqual([
        ada.participantId,
        self.participantId,
      ]);
      // Membership went away; the person's account is kept for other threads.
      const personRows = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants WHERE participant_id = ${grace.participantId}
      `) as Array<{ c: number }>;
      expect(Number(personRows[0].c)).toBe(1);
    });

    it("returns each participant's person-level facts, refreshed by a later snapshot", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      // A later snapshot: Ada changed her headline, and reports no type.
      await repo.upsertThreadParticipants("t1", [
        { ...ada, headline: "Countess of Lovelace", type: null },
        self,
      ]);

      const participants = await repo.getThreadParticipants("t1");
      const row = participants.find((p) => p.participantId === ada.participantId);
      expect(row?.name).toBe("Ada Lovelace");
      expect(row?.headline).toBe("Countess of Lovelace");
      // Null means "the snapshot did not say", never "unset what we learned".
      expect(row?.type).toBe("member");
      expect(row?.isSelf).toBe(false);
      expect(participants.find((p) => p.participantId === self.participantId)?.isSelf).toBe(true);
    });

    it("the reverse lookup returns every thread a participant belongs to", async () => {
      await repo.upsertThreads([
        thread("t1", new Date("2026-08-19T20:00:00Z")),
        thread("t2", new Date("2026-08-18T20:00:00Z")),
        thread("t3", new Date("2026-08-17T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      await repo.upsertThreadParticipants("t2", [ada, grace, self]);
      await repo.upsertThreadParticipants("t3", [grace, self]);

      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual(["t1", "t2"]);
      expect(await repo.getParticipantThreadIds(grace.participantId)).toEqual(["t2", "t3"]);
      expect(await repo.getParticipantThreadIds(self.participantId)).toEqual(["t1", "t2", "t3"]);
      expect(await repo.getParticipantThreadIds("ACoAANobody")).toEqual([]);
    });

    it("an empty set clears a thread's membership and reads back empty", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      await repo.upsertThreadParticipants("t1", []);

      expect(await repo.getThreadParticipants("t1")).toEqual([]);
      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual([]);
    });

    it("a failure part-way through a replace leaves the previous set intact", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [grace]);

      // More than one chunk, with the failure in the last one: without a
      // transaction the earlier chunks land and the thread ends up
      // over-inclusive — new members added, the departed one never deleted.
      const many = Array.from({ length: 200 }, (_, i) => ({
        participantId: `ACoAAFill${String(i).padStart(4, "0")}`,
        name: `Filler ${i}`,
        headline: null,
        type: "member",
        isSelf: false,
      }));
      // better-sqlite3 refuses to bind an object, so this throws mid-replace.
      const unbindable = {
        participantId: {} as unknown as string,
        name: "Boom",
        headline: null,
        type: "member",
        isSelf: false,
      };

      await expect(repo.upsertThreadParticipants("t1", [...many, unbindable])).rejects.toThrow();

      expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
        grace.participantId,
      ]);
      const accounts = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants
      `) as Array<{ c: number }>;
      expect(Number(accounts[0].c)).toBe(1);
    });

    it("is_self survives a re-snapshot and follows the viewer's answer", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      // A later snapshot reporting the same set must not flip the owner's row.
      await repo.upsertThreadParticipants("t1", [ada, self]);

      const after = await repo.getThreadParticipants("t1");
      expect(after.find((p) => p.participantId === self.participantId)?.isSelf).toBe(true);
      expect(after.find((p) => p.participantId === ada.participantId)?.isSelf).toBe(false);
    });

    it("membership is per thread — one thread's set never disturbs another's", async () => {
      await repo.upsertThreads([
        thread("t1", new Date("2026-08-19T20:00:00Z")),
        thread("t2", new Date("2026-08-18T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t1", [ada, grace]);
      await repo.upsertThreadParticipants("t2", [ada]);
      // Rewriting t2 down to nothing leaves t1 untouched.
      await repo.upsertThreadParticipants("t2", []);

      expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
        ada.participantId,
        grace.participantId,
      ]);
      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual(["t1"]);
    });

    // These tables are a cache of a pull-only mirror, so a read of them has to
    // say when it was taken. `getThreadParticipantSet` pairs the membership
    // with that timestamp; a null one means "never authoritatively read".
    describe("membership freshness", () => {
      it("a thread that has never been read reports a null last-read time", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants).toEqual([]);
        expect(set.lastReadAt).toBeNull();
      });

      it("replacing a thread's participants records when the membership was read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        const before = Date.now();
        await repo.upsertThreadParticipants("t1", [ada, self]);
        const after = Date.now();

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId)).toEqual([
          ada.participantId,
          self.participantId,
        ]);
        const readAt = set.lastReadAt?.getTime() ?? 0;
        // Second-resolution storage: floor the window so a read taken at
        // x.9s and stored as x.0s still lands inside it.
        expect(readAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(readAt).toBeLessThanOrEqual(after);
      });

      it("a later read advances the last-read time", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada]);
        // Backdate the first read so the second is unambiguously newer than it.
        testDb.db.run(
          sql`UPDATE linkedin_threads SET participants_last_read_at = 1000 WHERE thread_id = 't1'`,
        );

        await repo.upsertThreadParticipants("t1", [ada, grace]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.lastReadAt?.getTime()).toBeGreaterThan(1000 * 1000);
      });

      it("a re-read whose membership changed leaves the stored set matching it", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, grace, self]);
        // Grace left, a new member joined.
        await repo.upsertThreadParticipants("t1", [
          ada,
          self,
          { ...grace, participantId: "ACoAANew00004", name: "New Person" },
        ]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId).sort()).toEqual([
          ada.participantId,
          "ACoAANew00004",
          self.participantId,
        ]);
        expect(set.lastReadAt).not.toBeNull();
      });
    });

    // The count a reader sees is a fact about the stored membership, not a
    // scalar the thread snapshot volunteered. The two used to be independent —
    // the number said "5" while the table held three people and nothing could
    // tell which was wrong. No read hands that count out any more, so what is
    // left to hold is the schema: the column that allowed the disagreement.
    describe("participant count derived from membership", () => {
      it("the migrations drop the standalone participant_count column", () => {
        const columns = testDb.db.all(
          sql`SELECT name FROM pragma_table_info('linkedin_threads')`,
        ) as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).not.toContain("participant_count");
      });
    });

    // A mirrored participant becomes a Rome person through the existing person
    // create/link flow — there is no second write path here. The bare member id
    // is the account's address on both sides, so promotion needs no translation
    // step and nothing in this repository ever writes `persons`.
    describe("promotion to a person", () => {
      let people: PersonMappingRepository;

      const personCount = () =>
        Number(
          (testDb.db.all(sql`SELECT COUNT(*) AS n FROM persons`) as Array<{ n: number }>)[0].n,
        );

      beforeEach(async () => {
        people = new PersonMappingRepository(testDb.db);
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, self]);
      });

      it("lists a mirrored account as unpromoted until a person claims it", async () => {
        const rows = await repo.listParticipants();

        expect(rows.map((r) => r.participantId)).toEqual([ada.participantId, self.participantId]);
        expect(rows.map((r) => r.linkedPersonId)).toEqual([null, null]);
        expect(rows[0].threadCount).toBe(1);
      });

      it("bounds the participant read by default and reads it whole on limit: null", async () => {
        expect(await repo.listParticipants({ limit: 1 })).toHaveLength(1);
        expect(await repo.listParticipants({ limit: null })).toHaveLength(2);
        // The no-argument call is the one the address book's fold makes.
        expect(await repo.listParticipants()).toHaveLength(2);
      });

      it("promoting writes a person and a linkedin mapping carrying the member id", async () => {
        await people.create({
          displayName: "Ada Lovelace",
          bondLevel: "acquaintance",
          approved: true,
          channelMappings: [{ channel: "linkedin", channelUserId: ada.participantId }],
        });

        const mapping = (
          testDb.db.all(
            sql`SELECT channel, channel_user_id AS channelUserId, person_id AS personId
                FROM channel_mappings`,
          ) as Array<Record<string, string>>
        )[0];
        expect(mapping).toEqual({
          channel: "linkedin",
          channelUserId: ada.participantId,
          personId: "ada-lovelace",
        });

        const rows = await repo.listParticipants();
        const promoted = rows.find((r) => r.participantId === ada.participantId);
        expect(promoted?.linkedPersonId).toBe("ada-lovelace");
        expect(promoted?.linkedPersonName).toBe("Ada Lovelace");
        // The headline stays on the mirror row: `channel_mappings` has nowhere
        // to put it, and it belongs in the person's memory profile.
        expect(promoted?.headline).toBe("Engineer");
        // Promoting one account says nothing about the rest of the inbox.
        expect(rows.find((r) => r.participantId === self.participantId)?.linkedPersonId).toBeNull();
      });

      it("refuses to promote a participant a person already holds", async () => {
        await people.create({
          displayName: "Ada Lovelace",
          bondLevel: "acquaintance",
          approved: true,
          channelMappings: [{ channel: "linkedin", channelUserId: ada.participantId }],
        });

        // The second promotion slugs to a free id (`ada-lovelace-2`), so the
        // refusal is the held account's rather than a colliding person id's.
        await expect(
          people.create({
            displayName: "Ada Lovelace",
            bondLevel: "acquaintance",
            approved: true,
            channelMappings: [{ channel: "linkedin", channelUserId: ada.participantId }],
          }),
        ).rejects.toThrow(/already belongs to person/);

        expect(personCount()).toBe(1);
        expect((await repo.listParticipants())[0].linkedPersonId).toBe("ada-lovelace");
      });

      it("linking an already-promoted participant re-points the one mapping", async () => {
        await people.create({
          displayName: "Ada Lovelace",
          bondLevel: "acquaintance",
          approved: true,
          channelMappings: [{ channel: "linkedin", channelUserId: ada.participantId }],
        });
        await people.createWithId("ada-byron", {
          displayName: "Ada Byron",
          bondLevel: "inner-circle",
        });

        await people.addChannelMapping("ada-byron", "linkedin", ada.participantId);

        expect(personCount()).toBe(2);
        const rows = await repo.listParticipants();
        expect(rows.find((r) => r.participantId === ada.participantId)).toMatchObject({
          linkedPersonId: "ada-byron",
          linkedPersonName: "Ada Byron",
        });
      });
    });

    // Every sender the mirror already stored carries its member id inside
    // `linkedin_messages.sender_profile_url`, so the tables can be seeded from
    // data on disk rather than a fresh crawl.
    describe("backfill from stored messages", () => {
      const message = (
        threadId: string,
        messageId: string,
        overrides: Record<string, unknown> = {},
      ) => ({
        messageId,
        threadId,
        sentAt: new Date("2026-08-19T19:00:00Z"),
        senderName: "Ada Lovelace",
        senderProfileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
        senderHeadline: "Engineer",
        senderType: "member",
        senderIsSelf: false,
        text: "hi",
        subject: null,
        reactionCount: null,
        ...overrides,
      });

      it("seeds participants and membership from stored messages", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([
          message("t1", "m1"),
          message("t1", "m2", {
            senderName: "Me Myself",
            senderProfileUrl: "https://www.linkedin.com/in/ACoAASelf0003/",
            senderIsSelf: true,
            senderHeadline: null,
          }),
        ]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.threads).toBe(1);
        expect(result.participants).toBe(2);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId)).toEqual([
          "ACoAAAda0001",
          "ACoAASelf0003",
        ]);
        const seeded = set.participants.find((p) => p.participantId === "ACoAAAda0001");
        expect(seeded?.name).toBe("Ada Lovelace");
        expect(seeded?.headline).toBe("Engineer");
        expect(seeded?.type).toBe("member");
        expect(set.participants.find((p) => p.participantId === "ACoAASelf0003")?.isSelf).toBe(
          true,
        );
      });

      it("a seeded thread is not marked as read — the seed is not an authoritative read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([message("t1", "m1")]);

        await repo.backfillParticipantsFromMessages();

        // Senders alone cannot prove membership: a lurker is invisible here, so
        // the set must not claim the authority of a real participant read.
        expect((await repo.getThreadParticipantSet("t1")).lastReadAt).toBeNull();
      });

      it("skips a thread whose membership has already been read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        // The authoritative read says Grace is the only member; Ada has since
        // left, even though her messages are still mirrored.
        await repo.upsertThreadParticipants("t1", [grace]);
        await repo.upsertMessages([message("t1", "m1")]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.threads).toBe(0);

        expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
          grace.participantId,
        ]);
      });

      it("is idempotent and never duplicates an account across threads", async () => {
        await repo.upsertThreads([
          thread("t1", new Date("2026-08-19T20:00:00Z")),
          thread("t2", new Date("2026-08-18T20:00:00Z")),
        ]);
        await repo.upsertMessages([message("t1", "m1"), message("t2", "m2")]);

        await repo.backfillParticipantsFromMessages();
        await repo.backfillParticipantsFromMessages();

        const accounts = testDb.db.all(
          sql`SELECT participant_id FROM linkedin_participants`,
        ) as Array<{ participant_id: string }>;
        expect(accounts.map((r) => r.participant_id)).toEqual(["ACoAAAda0001"]);
        expect(await repo.getParticipantThreadIds("ACoAAAda0001")).toEqual(["t1", "t2"]);
      });

      it("keeps facts an authoritative read already learned", async () => {
        await repo.upsertThreads([
          thread("t1", new Date("2026-08-19T20:00:00Z")),
          thread("t2", new Date("2026-08-18T20:00:00Z")),
        ]);
        // t1 was read properly and learned Ada's headline; t2 only has her
        // messages, which report a stale headline.
        await repo.upsertThreadParticipants("t1", [{ ...ada, headline: "Countess of Lovelace" }]);
        await repo.upsertMessages([message("t2", "m1", { senderHeadline: "Engineer" })]);

        await repo.backfillParticipantsFromMessages();

        const t2 = await repo.getThreadParticipants("t2");
        expect(t2[0]?.headline).toBe("Countess of Lovelace");
      });

      it("ignores senders whose profile URL carries no member id", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([
          // A vanity URL is a public handle, not the member id the participant
          // tables key on, so it must not become a participant_id.
          message("t1", "m1", { senderProfileUrl: "https://www.linkedin.com/in/ada-lovelace/" }),
          message("t1", "m2", { senderProfileUrl: null }),
          message("t1", "m3"),
        ]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.participants).toBe(1);
        expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
          "ACoAAAda0001",
        ]);
      });
    });
  });

  // The People surface reads a participant as a person-shaped row: who they
  // are, what was last said, and how much of it there is. "What was said" is
  // the direct threads only — a timeline entry names no sender, so a group
  // thread's messages cannot be attributed to one of its members.
  describe("participant activity", () => {
    const ada = {
      participantId: "ACoAAAda0001",
      name: "Ada Lovelace",
      headline: "Engineer",
      type: "member",
      isSelf: false,
    };
    const grace = {
      participantId: "ACoAAGrace002",
      name: "Grace Hopper",
      headline: null,
      type: "member",
      isSelf: false,
    };
    const self = {
      participantId: "ACoAASelf0003",
      name: "Me Myself",
      headline: null,
      type: "member",
      isSelf: true,
    };

    const message = (
      threadId: string,
      messageId: string,
      at: string,
      text: string | null,
      overrides: { senderIsSelf?: boolean; subject?: string | null } = {},
    ) => ({
      messageId,
      threadId,
      sentAt: new Date(at),
      senderName: "Ada Lovelace",
      senderProfileUrl: `https://www.linkedin.com/in/${ada.participantId}/`,
      senderHeadline: null,
      senderType: "member",
      senderIsSelf: overrides.senderIsSelf ?? false,
      text,
      subject: overrides.subject ?? null,
      reactionCount: null,
    });

    const seconds = (at: string) => Math.floor(Date.parse(at) / 1000);

    const participantRow = async (participantId: string) => {
      const rows = await repo.listParticipants();
      const row = rows.find((r) => r.participantId === participantId);
      if (!row) throw new Error(`no participant row for ${participantId}`);
      return row;
    };

    beforeEach(async () => {
      await repo.upsertThreads([
        thread("t-direct", new Date("2026-08-19T20:00:00Z")),
        thread("t-group", new Date("2026-08-20T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t-direct", [ada, self]);
      await repo.upsertThreadParticipants("t-group", [ada, grace, self]);
      await repo.upsertMessages([
        message("t-direct", "m-1", "2026-08-19T10:00:00Z", "hello from the 1:1"),
        message("t-direct", "m-2", "2026-08-19T11:00:00Z", "on my way", { senderIsSelf: true }),
        message("t-group", "m-3", "2026-08-20T10:00:00Z", "hello everyone"),
      ]);
    });

    it("reports a direct thread's newest message, both directions counted", async () => {
      const row = await participantRow(ada.participantId);
      expect(row.lastMessageAt).toBe(seconds("2026-08-19T11:00:00Z"));
      expect(row.lastMessagePreview).toBe("on my way");
      expect(row.messageCount).toBe(2);
    });

    it("leaves a group thread out of a member's activity", async () => {
      // Grace is only ever on the group thread, so nothing is attributable to
      // her — the newer group message is not her news, and never Ada's either.
      expect(await participantRow(grace.participantId)).toMatchObject({
        lastMessageAt: null,
        lastMessagePreview: null,
        messageCount: 0,
      });
      const row = await participantRow(ada.participantId);
      expect(row.lastMessageAt).toBeLessThan(seconds("2026-08-20T10:00:00Z"));
    });

    it("counts a thread LinkedIn calls a group as one, whatever its membership says", async () => {
      // The flag gets a veto over the membership: a two-row participant set on
      // a thread the snapshot flagged as a group is a set that was read before
      // the rest of the members were.
      await repo.upsertThreads([thread("t-flagged", new Date("2026-08-21T20:00:00Z"))]);
      await repo.markThreadSynced("t-flagged", { isGroup: true });
      await repo.upsertThreadParticipants("t-flagged", [grace, self]);
      await repo.upsertMessages([
        message("t-flagged", "m-4", "2026-08-21T10:00:00Z", "in a group"),
      ]);

      expect((await participantRow(grace.participantId)).messageCount).toBe(0);
    });

    it("treats a thread with no snapshot as direct when only one member is on it", async () => {
      // `is_group` stays null until a thread snapshot reports one, and a thread
      // seeded from stored messages has membership but no snapshot. Reading the
      // flag alone would make every such thread nobody's history.
      const flag = testDb.db.all(
        sql`SELECT is_group AS isGroup FROM linkedin_threads WHERE thread_id = 't-direct'`,
      ) as Array<Record<string, unknown>>;
      expect(flag[0].isGroup).toBeNull();
      expect((await participantRow(ada.participantId)).messageCount).toBe(2);
    });

    it("falls back to the InMail subject when a message carries no text", async () => {
      await repo.upsertMessages([
        message("t-direct", "m-5", "2026-08-19T12:00:00Z", null, { subject: "Role at Analytical" }),
      ]);
      expect((await participantRow(ada.participantId)).lastMessagePreview).toBe(
        "Role at Analytical",
      );
    });
  });
});

describe("linkedInMemberIdFromProfileUrl", () => {
  it("extracts the member id from the stored profile URL forms", () => {
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ACoAAAda0001/")).toBe(
      "ACoAAAda0001",
    );
    expect(
      linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ACoAAAda0001?trk=messaging"),
    ).toBe("ACoAAAda0001");
    expect(linkedInMemberIdFromProfileUrl("/in/ACoAAAda0001/")).toBe("ACoAAAda0001");
  });

  it("returns null for anything that is not a member id", () => {
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ada-lovelace/")).toBeNull();
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/company/acme/")).toBeNull();
    expect(linkedInMemberIdFromProfileUrl(null)).toBeNull();
    expect(linkedInMemberIdFromProfileUrl("")).toBeNull();
  });
});
