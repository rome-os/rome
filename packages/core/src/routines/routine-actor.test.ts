// Whom a reminder's push reaches: a routine records who created it, its fire
// acts for them, and send_notification in its chat rings that person.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import type { SessionActor } from "../access/session-actor.js";
import { runWithSessionActor } from "../access/session-actor.js";
import type { ActionEngine, ActionRunContext } from "../apps/actions/engine.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import { sendForCaller } from "../apps/actions/caller-notify.js";
import { privateOwnerOf } from "../concierge/privacy.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { guardianAuth, routines as routinesTable } from "../db/schema.js";
import type { SendOutcome, SystemNotifyContent } from "../lib/notify-client.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { RoutineEngine } from "./engine.js";
import { legacyRoutineActor } from "./legacy-actor.js";

const guardian: SessionActor = { kind: "guardian", userId: "seat-1", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "acct-v", email: "v@example.com" };
const remindAt5 = {
  name: "remind me at 5",
  trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "17:00" } as const,
  actionName: "resume_session",
};

describe("a reminder's push", () => {
  let testDb: TestDb;
  let routines: RoutinesRepository;
  let engine: RoutineEngine;
  let outcomes: SendOutcome[];
  let pushes: Array<SystemNotifyContent | undefined>;

  beforeEach(async () => {
    testDb = createTestDb();
    await testDb.db
      .insert(guardianAuth)
      .values({ id: "auth-1", userId: "seat-1", passwordHash: "x", createdAt: new Date() });
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    // An ordinary chat the guardian made, which every dashboard user may open.
    await webchatRepo.createSession("shared", "Plans");
    // A visitor's ordinary chat, shared too.
    await webchatRepo.createSession(
      "visitor-chat",
      "Mine",
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      "webchat",
      null,
      { ownerKey: "visitor:acct-v" },
    );
    routines = new RoutinesRepository(testDb.db);
    outcomes = [];
    pushes = [];
    const notify = {
      send: async (content?: SystemNotifyContent): Promise<SendOutcome> => {
        pushes.push(content);
        return { kind: "ok", attempted: 1, sent: 1, failed: 0 };
      },
    };
    // The woken turn calls send_notification in its chat, acting for the fire's person.
    const actionEngine = {
      run: async (_name: string, args: Record<string, unknown>, context?: ActionRunContext) => {
        outcomes.push(
          await sendForCaller(
            notify,
            async (chatId) => privateOwnerOf(await webchatRepo.getSession(chatId)),
            { actor: context?.actor, chatId: args.threadId as string },
            { body: "It is 5" },
          ),
        );
        return { status: "ok", data: null };
      },
    } as unknown as ActionEngine;
    engine = new RoutineEngine(
      routines,
      new RoutineRunsRepository(testDb.db),
      actionEngine,
      0,
      systemClock,
      (routine) => legacyRoutineActor(routine, { db: testDb.db, webchatRepo }),
    );
  });

  afterEach(() => testDb.close());

  /** A reminder a turn acting for `actor` schedules in `chat`, as `defer` does. */
  const remindFrom = (actor: SessionActor | undefined, chat: string) =>
    actionExecutionContext.run(
      { executionId: "e", rootExecutionId: "e", initiator: "agent:core:main", actor },
      () => routines.create({ ...remindAt5, args: { channel: "webchat", threadId: chat } }),
    );

  it("rings the guardian, and a visitor, for the reminder each set in a shared chat", async () => {
    await engine.runNow(await remindFrom(guardian, "shared"));
    await engine.runNow(await remindFrom(visitor, "shared"));
    expect(pushes).toEqual([{ body: "It is 5" }, { body: "It is 5", recipient: "acct-v" }]);
  });

  it("rings the person who turned a routine on in Settings, not whoever runs it now", async () => {
    const id = await runWithSessionActor(visitor, () =>
      routines.create({ ...remindAt5, args: { channel: "webchat", threadId: "shared" } }),
    );
    await runWithSessionActor(guardian, () => engine.runNow(id));
    expect(pushes).toEqual([{ body: "It is 5", recipient: "acct-v" }]);
  });

  it("rings the guardian for an app's routine", async () => {
    const id = await actionExecutionContext.run(
      { executionId: "e", rootExecutionId: "e", initiator: "app:briefing", actor: visitor },
      () =>
        routines.create({
          ...remindAt5,
          managedBy: "briefing",
          args: { channel: "webchat", threadId: "shared" },
        }),
    );
    await engine.runNow(id);
    expect(pushes).toEqual([{ body: "It is 5" }]);
  });

  it("rings a legacy routine's chat owner", async () => {
    const legacy = async (chat: string) => {
      const id = await routines.create({
        ...remindAt5,
        args: { channel: "webchat", threadId: chat },
      });
      await testDb.db
        .update(routinesTable)
        .set({ createdBy: null })
        .where(eq(routinesTable.id, id));
      return id;
    };
    await engine.runNow(await legacy("visitor-chat"));
    await engine.runNow(await legacy("shared"));
    expect(pushes).toEqual([{ body: "It is 5", recipient: "acct-v" }, { body: "It is 5" }]);
  });

  it("refuses a reminder set by a turn that acts for no one, in a shared chat", async () => {
    // A turn with more than one person's input runs its actions as no one.
    const id = await remindFrom(undefined, "shared");
    expect((await routines.findById(id))?.createdBy).toEqual({ kind: "anonymous" });
    await engine.runNow(id);
    expect(outcomes).toEqual([{ kind: "recipient_unknown" }]);
    expect(pushes).toEqual([]);
  });
});
