import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import type { TalkRouter } from "@rome-os/app-runtime";
import type {
  OutboxMessage,
  OutboxPage,
  PersonResource,
  TimelinePage,
} from "@rome/api-types/people";
import { createLinkedInDescriptor } from "../../connections/integrations/linkedin.js";
import type { Credential, RuntimeKit } from "../../connections/types.js";
import type { OpencliResult } from "../../channels/linkedin-cli.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { peopleRoutes } from "./people.js";

const MEMBER = "ACoAARecipient";
const SELF = "ACoAAOwner";
const THREAD = "2-reply==";
const URL = `https://www.linkedin.com/messaging/thread/${THREAD}/`;
const reply = {
  status: "sent",
  thread_id: THREAD,
  message_id: "provider-reply-1",
  sender_is_self: true,
  sender_profile_url: `https://www.linkedin.com/in/${SELF}/`,
  sent_at: new Date().toISOString(),
  text: "Thanks for reaching out",
};

describe("LinkedIn replies through People", () => {
  let db: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let person: string;
  const run = rs.fn<() => Promise<OpencliResult>>();
  let send: TalkRouter["send"];

  beforeEach(async () => {
    db = createTestDb();
    deps = await buildTestDeps(db.db);
    run.mockReset();
    run.mockResolvedValue({ code: 0, stdout: JSON.stringify([reply]), stderr: "" });
    await deps.linkedInStoreRepo.upsertThreads([
      { threadId: THREAD, threadUrl: URL, unread: false },
    ]);
    await deps.linkedInStoreRepo.upsertThreadParticipants(THREAD, [
      { participantId: MEMBER, type: "member", isSelf: false },
      { participantId: SELF, type: "member", isSelf: true },
    ]);
    await deps.linkedInStoreRepo.markThreadSynced(THREAD, { isGroup: false });
    const talker = createLinkedInDescriptor({
      syncSink: deps.linkedInStoreRepo,
      run,
      minIntervalMs: 60_000,
      maxIntervalMs: 60_000,
    }).capabilities.talker!.build({} as Record<string, Credential>, {} as RuntimeKit);
    send = (_connection, conversation, message) => talker.send(conversation, message);
    deps.talkRouter = {
      ...deps.talkRouter,
      list: async () => [{ connectionId: "linkedin", service: "linkedin" }],
      feature: (_id, name) => talker.feature(name),
      send: (...args) => send(...args),
    };
    person = await deps.personMappingRepo.create({
      displayName: "LinkedIn Recipient",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "linkedin", channelUserId: MEMBER }],
    });
    app = new Hono().route("/", peopleRoutes(deps));
  });

  afterEach(() => db.close());

  const post = () =>
    app.request(`/people/${person}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "linkedin", channelUserId: MEMBER, text: reply.text }),
    });
  const outbox = async () =>
    (await (await app.request(`/people/${person}/outbox`)).json()) as OutboxPage;

  it("exposes the shared composer and reconciles the provider receipt with the mirrored timeline", async () => {
    const resource = (await (await app.request(`/people/${person}`)).json()) as PersonResource;
    expect(resource.accounts[0].send).toBe("yes");
    expect(run).not.toHaveBeenCalled();
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      state: "unconfirmed",
      ref: `${THREAD}:${reply.message_id}`,
    });
    expect(run).toHaveBeenCalledWith(
      [
        "linkedin",
        "reply",
        "--thread-url",
        URL,
        "--expected-recipient",
        MEMBER,
        "--expected-self",
        SELF,
        "--message",
        reply.text,
        "--send",
      ],
      { timeoutMs: 180_000 },
    );
    const timeline = (await (
      await app.request(`/people/${person}/messages`)
    ).json()) as TimelinePage;
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      ref: `${THREAD}:${reply.message_id}`,
      direction: "outbound",
      body: reply.text,
    });
    expect((await outbox()).messages).toEqual([]);
  });

  it("keeps a failed reply and retries the same outbox row", async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "LinkedIn rejected the reply" });
    const failed = (await (await post()).json()) as OutboxMessage;
    expect(failed.state).toBe("failed");
    expect((await outbox()).messages[0].id).toBe(failed.id);
    const response = await app.request(`/people/${person}/outbox/${failed.id}/retry`, {
      method: "POST",
    });
    expect(await response.json()).toMatchObject({ id: failed.id, state: "unconfirmed" });
    expect((await outbox()).messages).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps acceptance when the local mirror write fails, then clears on a provider echo by id", async () => {
    const upsert = rs
      .spyOn(deps.linkedInStoreRepo, "upsertMessages")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    expect(await (await post()).json()).toMatchObject({ state: "unconfirmed" });
    expect((await outbox()).messages).toHaveLength(1);
    upsert.mockRestore();
    await deps.linkedInStoreRepo.upsertMessages([
      { threadId: THREAD, messageId: "same-text-other-id", senderIsSelf: true, text: reply.text },
    ]);
    expect((await outbox()).messages).toHaveLength(1);
    await deps.linkedInStoreRepo.upsertMessages([
      { threadId: THREAD, messageId: reply.message_id, senderIsSelf: true, text: reply.text },
    ]);
    expect((await outbox()).messages).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a group before spawning a send", async () => {
    await deps.linkedInStoreRepo.markThreadSynced(THREAD, { isGroup: true });
    expect((await post()).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not retarget a failed reply when the direct conversation changes", async () => {
    run.mockRejectedValueOnce(new Error("offline"));
    const failed = (await (await post()).json()) as OutboxMessage;
    rs.spyOn(deps.linkedInStoreRepo, "findReplyTarget").mockResolvedValue({
      threadId: "different-thread",
      threadUrl: "https://www.linkedin.com/messaging/thread/different-thread/",
      participantId: MEMBER,
      selfParticipantId: SELF,
    });
    await app.request(`/people/${person}/outbox/${failed.id}/retry`, { method: "POST" });
    expect((await outbox()).messages[0]).toMatchObject({
      state: "failed",
      error: expect.stringContaining("conversation changed"),
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
