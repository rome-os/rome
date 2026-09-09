import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { getRegistry } from "@jackwener/opencli/registry";
import { parseThreadMessagePayloads } from "./thread-snapshot-helpers.mjs";
import { parseReplyReceipt, postLinkedInReply, verifiedReplyTarget } from "./reply-helpers.mjs";
import "./reply.js";

const threadId = "2-target==";
const threadUrl = `https://www.linkedin.com/messaging/thread/${threadId}/`;
const recipientId = "ACoAARecipient";
const selfId = "ACoAAOwner";
const mailboxUrn = `urn:li:fsd_profile:${selfId}`;
const conversationUrn = `urn:li:msg_conversation:(${mailboxUrn},${threadId})`;
const sender = `urn:li:msg_messagingParticipant:${mailboxUrn}`;
const recipient = `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${recipientId}`;
const expected = { threadId, threadUrl, recipientId, selfId };
const text = "Hello 👋\n\n  Thanks for the details.";
const originToken = "12345678-1234-4123-8123-123456789012";
const conversationApi =
  "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abcdef&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3Aowner)";

function payload() {
  return {
    __opencli: { conversation_participant_refs_complete: true },
    included: [
      {
        $type: "com.linkedin.messenger.Conversation",
        entityUrn: conversationUrn,
        backendUrn: `urn:li:messagingThread:${threadId}`,
        groupChat: false,
        "*conversationParticipants": [sender, recipient],
      },
      ...[
        [sender, "SELF"],
        [recipient, "DISTANCE_1"],
      ].map(([entityUrn, distance]) => ({
        $type: "com.linkedin.messenger.MessagingParticipant",
        entityUrn,
        participantType: { member: { firstName: { text: "Member" }, distance } },
      })),
    ],
  };
}
function message(overrides = {}) {
  return {
    $type: "com.linkedin.messenger.Message",
    entityUrn: "urn:li:msg_message:(owner,sent-123)",
    backendUrn: "urn:li:messagingMessage:sent-123",
    "*conversation": conversationUrn,
    backendConversationUrn: `urn:li:messagingThread:${threadId}`,
    "*sender": sender,
    body: { text },
    deliveredAt: 1789000000000,
    originToken,
    ...overrides,
  };
}

test("destination verification requires complete direct membership and both account ids", () => {
  assert.deepEqual(verifiedReplyTarget(payload(), expected), { conversationUrn, mailboxUrn });
  for (const mutate of [
    (p) => {
      p.__opencli.conversation_participant_refs_complete = false;
    },
    (p) => {
      p.included[0].groupChat = true;
    },
    (p) => {
      delete p.included[0].groupChat;
    },
    (p) => {
      p.included[0]["*conversationParticipants"].push("another-member");
    },
    (p) => {
      p.included[1].participantType.member.distance = "DISTANCE_1";
    },
    (p) => {
      p.included[0].entityUrn = `urn:li:msg_conversation:(other,${threadId})`;
    },
  ]) {
    const p = payload();
    mutate(p);
    assert.throws(() => verifiedReplyTarget(p, expected));
  }
  assert.throws(() => verifiedReplyTarget(payload(), { ...expected, recipientId: "ACoAAOther" }));
  assert.throws(() => verifiedReplyTarget(payload(), { ...expected, selfId: "ACoAAOther" }));
  assert.throws(() => verifiedReplyTarget(null, expected));
});

test("a reply receipt and a later snapshot use the same provider id", () => {
  const receipt = parseReplyReceipt({ data: { value: message() } }, payload(), {
    ...expected,
    originToken,
  });
  const [mirrored] = parseThreadMessagePayloads(
    [{ included: [...payload().included, message()] }],
    { ...expected, limit: 20 },
  );
  assert.equal(receipt.message_id, mirrored.message_id);
  assert.equal(receipt.message_id, "sent-123");
  assert.equal(receipt.status, "sent");
});

test("receipt parsing rejects unknown, unrelated, inbound, or incomplete results", () => {
  for (const value of [
    {},
    { status: "sent" },
    message({ backendUrn: undefined }),
    message({ originToken: "another-send" }),
    message({ "*sender": recipient }),
    message({ deliveredAt: null }),
    message({ backendConversationUrn: "urn:li:messagingThread:other", "*conversation": "other" }),
  ]) {
    assert.throws(
      () => parseReplyReceipt({ value }, payload(), { ...expected, originToken }),
      /outcome is unknown/,
    );
  }
});

test("the browser write makes exactly one scoped POST and preserves the message", async () => {
  const calls = [];
  const result = await vm.runInNewContext(`(${postLinkedInReply.toString()})(...args)`, {
    URL,
    location: new URL(threadUrl),
    args: ["csrf", { conversationUrn, mailboxUrn }, text, originToken, "tracking", threadUrl],
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, json: async () => ({ value: message() }) };
    },
  });
  assert.ok(result.json);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
  );
  assert.equal(calls[0].options.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    message: {
      body: { attributes: [], text },
      renderContentUnions: [],
      conversationUrn,
      originToken,
    },
    mailboxUrn,
    trackingId: "tracking",
    dedupeByClientGeneratedToken: false,
  });
});

test("navigation changes block the POST, and unknown outcomes never trigger a second POST", async () => {
  for (const mode of ["navigation", "timeout", "server-error", "auth", "rejected"]) {
    let calls = 0;
    const result = await vm.runInNewContext(`(${postLinkedInReply.toString()})(...args)`, {
      URL,
      location: new URL(mode === "navigation" ? "https://www.linkedin.com/feed/" : threadUrl),
      args: ["csrf", { conversationUrn, mailboxUrn }, text, originToken, "tracking", threadUrl],
      fetch: async () => {
        calls++;
        if (mode === "timeout") throw new Error("timeout");
        return { ok: false, status: mode === "auth" ? 401 : mode === "rejected" ? 422 : 503 };
      },
    });
    assert.equal(calls, mode === "navigation" ? 0 : 1);
    if (mode === "timeout" || mode === "server-error") assert.equal(result.uncertain, true);
    if (mode === "auth") assert.equal(result.auth_required, true);
    if (mode === "rejected" || mode === "navigation") assert.ok(result.error);
  }
});

function fakePage({ conversation = payload(), outcome = null } = {}) {
  const writes = [];
  return {
    writes,
    goto: async () => {},
    wait: async () => {},
    getCookies: async () => [{ name: "JSESSIONID", value: '"csrf"' }],
    evaluate: async (fn, ...args) => {
      if (fn.name === "inspectLinkedInThreadPage")
        return {
          current_url: threadUrl,
          initial_url: "found",
          conversation_urls: [conversationApi],
        };
      if (fn.name === "fetchLinkedInConversationApi") return { json: conversation };
      if (fn.name === "postLinkedInReply") {
        writes.push(args);
        return outcome ?? { json: { value: message({ originToken: args[3] }) } };
      }
      throw new Error(`Unexpected function ${fn.name}`);
    },
  };
}
const args = {
  "thread-url": threadUrl,
  "expected-recipient": recipientId,
  "expected-self": selfId,
  message: text,
};

test("the command defaults to verifying only and requires --send for the one write", async () => {
  const command = getRegistry().get("linkedin/reply");
  assert.equal(command.access, "write");
  const page = fakePage();
  assert.equal((await command.func(page, args))[0].status, "verified_dry_run");
  assert.equal(page.writes.length, 0);
  const [receipt] = await command.func(page, { ...args, send: true });
  assert.equal(receipt.message_id, "sent-123");
  assert.equal(page.writes.length, 1);
  assert.equal(page.writes[0][2], text);
  assert.equal(page.writes[0][4].length, 16);
});

test("the command refuses unverified recipients and reports uncertain outcomes without retrying", async () => {
  const command = getRegistry().get("linkedin/reply");
  const wrong = fakePage();
  await assert.rejects(
    command.func(wrong, { ...args, "expected-recipient": "ACoAAOther", send: true }),
  );
  assert.equal(wrong.writes.length, 0);
  const unknown = fakePage({ outcome: { uncertain: true } });
  await assert.rejects(command.func(unknown, { ...args, send: true }), /outcome is unknown/);
  assert.equal(unknown.writes.length, 1);
});
