import assert from "node:assert/strict";
import test from "node:test";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { getRegistry } from "@jackwener/opencli/registry";
import {
  canonicalizeLinkedInThreadUrl,
  deriveConversationIsGroup,
  inspectLinkedInThreadPage,
  isThreadConversationApiUrl,
  isThreadMessageApiUrl,
  linkedInThreadId,
  normalizeThreadMessageLimit,
  parseThreadMessagePayloads,
  selectThreadMessageApiUrls,
  validateThreadConversationPayload,
} from "./thread-snapshot-helpers.mjs";
import "./thread-snapshot.js";

const THREAD_ID = "2-target==";
const THREAD_URL = `https://www.linkedin.com/messaging/thread/${THREAD_ID}/`;
const OTHER_THREAD_ID = "2-other==";
const SELF = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:self";
const EVAN = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:evan";

function apiUrl(threadId, page = false) {
  const variables = page
    ? `(deliveredAt:1000,conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3Aself%2C${encodeURIComponent(threadId)}%29,countBefore:20,countAfter:0)`
    : `(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3Aself%2C${encodeURIComponent(threadId)}%29)`;
  return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.abcdef0123456789&variables=${variables}`;
}

function conversationApiUrl(suffix = "") {
  return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abcdef0123456789&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3Aself${suffix})`;
}

function participant(entityUrn, firstName, lastName, distance, headline = "") {
  return {
    $type: "com.linkedin.messenger.MessagingParticipant",
    entityUrn,
    participantType: {
      member: {
        firstName: { text: firstName },
        lastName: { text: lastName },
        distance,
        headline: { text: headline },
        profileUrl: `https://www.linkedin.com/in/${firstName.toLowerCase()}/`,
      },
    },
  };
}

function message(id, threadId, sender, deliveredAt, text) {
  return {
    $type: "com.linkedin.messenger.Message",
    entityUrn: `urn:li:msg_message:${id}`,
    backendUrn: `urn:li:messagingMessage:${id}`,
    backendConversationUrn: `urn:li:messagingThread:${threadId}`,
    "*conversation": `urn:li:msg_conversation:(urn:li:fsd_profile:self,${threadId})`,
    "*sender": sender,
    deliveredAt,
    body: { text },
    reactionSummaries: [],
  };
}

function payload(messages, extras = [], conversation = {}) {
  const self = participant(SELF, "Yunfan", "Ye", "SELF", "Builder");
  const evan = participant(EVAN, "Evan", "Ye", "DISTANCE_1", "Founder");
  const participants = [self, evan, ...extras].filter(
    (entity) => entity?.$type === "com.linkedin.messenger.MessagingParticipant",
  );
  return {
    __opencli: { conversation_participant_refs_complete: true },
    included: [
      {
        $type: "com.linkedin.messenger.Conversation",
        entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
        backendUrn: `urn:li:messagingThread:${THREAD_ID}`,
        "*conversationParticipants": participants.map((entity) => entity.entityUrn),
        ...conversation,
      },
      self,
      evan,
      ...messages,
      ...extras,
    ],
  };
}

function sparseMessagePayload(text = "hello group") {
  return {
    included: [
      {
        $type: "com.linkedin.messenger.Conversation",
        entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
      },
      participant(SELF, "Yunfan", "Ye", "SELF", "Builder"),
      message("g1", THREAD_ID, SELF, 1000, text),
    ],
  };
}

test("thread URLs accept only exact HTTPS LinkedIn messaging routes", () => {
  assert.equal(canonicalizeLinkedInThreadUrl(`${THREAD_URL}?trk=inbox#latest`), THREAD_URL);
  assert.equal(linkedInThreadId(THREAD_URL), THREAD_ID);
  assert.equal(
    canonicalizeLinkedInThreadUrl(`https://linkedin.com/messaging/thread/${THREAD_ID}`),
    THREAD_URL,
  );
  assert.equal(canonicalizeLinkedInThreadUrl("https://www.linkedin.com/messaging/"), "");
  assert.equal(canonicalizeLinkedInThreadUrl(`${THREAD_URL}extra`), "");
  assert.equal(
    canonicalizeLinkedInThreadUrl(`https://evil-linkedin.com/messaging/thread/${THREAD_ID}/`),
    "",
  );
  assert.equal(
    canonicalizeLinkedInThreadUrl(`http://www.linkedin.com/messaging/thread/${THREAD_ID}/`),
    "",
  );
});

test("message limits reject out-of-range and fractional values", () => {
  assert.equal(normalizeThreadMessageLimit(undefined), 20);
  assert.equal(normalizeThreadMessageLimit(1), 1);
  assert.equal(normalizeThreadMessageLimit("100"), 100);
  assert.throws(() => normalizeThreadMessageLimit(0), /between 1 and 100/);
  assert.throws(() => normalizeThreadMessageLimit(101), /between 1 and 100/);
  assert.throws(() => normalizeThreadMessageLimit(1.5), /between 1 and 100/);
});

test("messaging API URL selection is scoped to the exact requested thread", () => {
  const initial = apiUrl(THREAD_ID);
  const page = apiUrl(THREAD_ID, true);
  const other = apiUrl(OTHER_THREAD_ID);
  const selected = selectThreadMessageApiUrls([other, initial, page, initial], THREAD_ID);
  assert.equal(isThreadMessageApiUrl(initial, THREAD_ID), true);
  assert.equal(isThreadMessageApiUrl(other, THREAD_ID), false);
  assert.equal(
    isThreadMessageApiUrl(
      `https://example.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.abcdef&variables=,${THREAD_ID})`,
      THREAD_ID,
    ),
    false,
  );
  assert.deepEqual(selected, { initial_url: initial, page_urls: [page] });
});

test("conversation API URLs accept only LinkedIn GraphQL requests", () => {
  assert.equal(isThreadConversationApiUrl(conversationApiUrl()), true);
  assert.equal(
    isThreadConversationApiUrl(
      "https://example.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abcdef",
    ),
    false,
  );
});

test("conversation payload validation rejects unrelated entities after page-side scoping", () => {
  const target = payload([], [], { title: "Target", groupChat: false });
  assert.equal(validateThreadConversationPayload(target, THREAD_ID), target);

  const other = {
    $type: "com.linkedin.messenger.Conversation",
    entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${OTHER_THREAD_ID})`,
    backendUrn: `urn:li:messagingThread:${OTHER_THREAD_ID}`,
    title: "Other",
  };
  target.included.push(other, participant("unrelated", "Other", "Person", "DISTANCE_1"));
  assert.throws(
    () => validateThreadConversationPayload(target, THREAD_ID),
    /different thread|unrelated conversation data/,
  );
});

test("payload parsing returns the latest requested messages with sender metadata", () => {
  const messages = [
    message("m1", THREAD_ID, SELF, 1000, "first"),
    message("m2", THREAD_ID, EVAN, 2000, "second"),
    message("m3", THREAD_ID, SELF, 3000, "third"),
  ];
  const other = message("other", OTHER_THREAD_ID, EVAN, 4000, "not in this thread");
  const rows = parseThreadMessagePayloads([payload(messages, [other])], {
    threadId: THREAD_ID,
    threadUrl: THREAD_URL,
    limit: 2,
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["second", "third"],
  );
  assert.ok(rows.every((row) => row.thread_id === THREAD_ID));
  assert.ok(rows.every((row) => !row.text.includes("not in this thread")));
  // A 1:1 thread's conversation_name is the counterparty's name (the display
  // ladder), so it must never read as a group signal — the discriminator is
  // conversation_is_group, and the raw title stays empty here.
  assert.equal(rows[0].conversation_name, "Evan Ye");
  assert.equal(rows[0].conversation_title, "");
  assert.equal(rows[0].conversation_is_group, false);
  assert.equal(rows[0].participant_count, 2);
  assert.equal(rows[0].sender_name, "Evan Ye");
  assert.equal(rows[0].sender_is_self, false);
  assert.equal(rows[0].sender_headline, "Founder");
  assert.equal(rows[1].sender_name, "Yunfan Ye");
  assert.equal(rows[1].sender_is_self, true);
  assert.equal(rows[1].returned_index, 2);
  assert.equal(rows[1].returned_message_count, 2);
  assert.equal(rows[1].is_latest, true);
  assert.equal(rows[1].sent_at, "1970-01-01T00:00:03.000Z");
});

test("group-ness comes from the API's groupChat flag, with the title kept raw", () => {
  const MIRA = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:mira";
  const rows = parseThreadMessagePayloads(
    [
      payload(
        [message("g1", THREAD_ID, EVAN, 1000, "notes attached")],
        [participant(MIRA, "Mira", "Chen", "DISTANCE_1", "Designer")],
        { title: "Pitch review", groupChat: true },
      ),
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );
  assert.equal(rows[0].conversation_name, "Pitch review");
  assert.equal(rows[0].conversation_title, "Pitch review");
  assert.equal(rows[0].conversation_is_group, true);
  assert.equal(rows[0].participant_count, 3);
});

test("a payload without groupChat falls back to counting counterparties", () => {
  const MIRA = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:mira";
  const rows = parseThreadMessagePayloads(
    [
      payload(
        [message("g1", THREAD_ID, EVAN, 1000, "hello both")],
        [participant(MIRA, "Mira", "Chen", "DISTANCE_1", "Designer")],
      ),
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );
  // No title and no flag: the name is the joined counterparties, and two of
  // them is the honest group signal.
  assert.equal(rows[0].conversation_name, "Evan Ye, Mira Chen");
  assert.equal(rows[0].conversation_title, "");
  assert.equal(rows[0].conversation_is_group, true);
});

test("group derivation preserves authoritative, complete, and sparse states", () => {
  assert.equal(deriveConversationIsGroup(false, [SELF, EVAN, "third"], ["Evan"]), false);
  assert.equal(deriveConversationIsGroup(null, [SELF, EVAN, "third"], ["Evan"]), true);
  assert.equal(deriveConversationIsGroup(null, [SELF, EVAN], ["Evan"]), false);
  assert.equal(deriveConversationIsGroup(null, undefined, ["Evan", "Mira"]), true);
  assert.equal(deriveConversationIsGroup(null, undefined, ["Evan"]), null);
});

test("sparse message payloads do not mislabel unknown metadata as 1:1", () => {
  const rows = parseThreadMessagePayloads(
    [
      {
        included: [
          {
            $type: "com.linkedin.messenger.Conversation",
            entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
          },
          participant(SELF, "Yunfan", "Ye", "SELF", "Builder"),
          message("m1", THREAD_ID, SELF, 1000, "hello"),
        ],
      },
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );
  assert.equal(rows[0].conversation_is_group, null);
  assert.equal(rows[0].participant_count, null);
});

test("empty and single participant-ref arrays remain unknown", () => {
  for (const refs of [[], [SELF]]) {
    const sparse = payload([message("m1", THREAD_ID, SELF, 1000, "hello")], [], {
      "*conversationParticipants": refs,
    });
    const rows = parseThreadMessagePayloads([sparse], {
      threadId: THREAD_ID,
      threadUrl: THREAD_URL,
      limit: 20,
    });
    assert.equal(rows[0].conversation_is_group, null);
    assert.equal(rows[0].participant_count, null);
  }
});

test("payload parsing deduplicates messages across API pages", () => {
  const first = message("m1", THREAD_ID, SELF, 1000, "first");
  const second = message("m2", THREAD_ID, EVAN, 2000, "second");
  const rows = parseThreadMessagePayloads([payload([second]), payload([first, second])], {
    threadId: THREAD_ID,
    threadUrl: THREAD_URL,
    limit: 20,
  });
  assert.deepEqual(
    rows.map((row) => row.message_id),
    ["m1", "m2"],
  );
});

test("message text keeps its line breaks", () => {
  const signed = "See https://example.com/demo\n\nExample signature";
  const rows = parseThreadMessagePayloads(
    [
      payload([
        message("m1", THREAD_ID, SELF, 1000, signed),
        message("m2", THREAD_ID, EVAN, 2000, "  First line \r\nSecond\u00a0line\rThird  \n\n"),
        {
          ...message("m3", THREAD_ID, EVAN, 3000, ""),
          renderContentFallbackText: "Shared a link\nhttps://example.com/demo",
        },
      ]),
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );

  assert.deepEqual(
    rows.map((row) => row.text),
    [signed, "First line\nSecond line\nThird", "Shared a link\nhttps://example.com/demo"],
  );
});

test("the browser probe selects only the target thread request", () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const originalPerformance = globalThis.performance;
  globalThis.document = { title: "Messaging | LinkedIn", body: { innerText: "Messaging" } };
  globalThis.location = { href: THREAD_URL };
  globalThis.performance = {
    getEntriesByType: () => [
      { name: conversationApiUrl() },
      { name: apiUrl(OTHER_THREAD_ID) },
      { name: apiUrl(THREAD_ID) },
      { name: apiUrl(THREAD_ID, true) },
    ],
  };
  try {
    assert.deepEqual(inspectLinkedInThreadPage(THREAD_ID), {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: apiUrl(THREAD_ID),
      page_urls: [apiUrl(THREAD_ID, true)],
      conversation_urls: [conversationApiUrl()],
    });
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
    globalThis.performance = originalPerformance;
  }
});

function fakePage({ probe, responses }) {
  const calls = { goto: [], evaluate: [] };
  return {
    calls,
    goto: async (url) => calls.goto.push(url),
    wait: async () => {},
    getCookies: async () => [{ name: "JSESSIONID", value: '"csrf"' }],
    evaluate: async (fn, ...args) => {
      calls.evaluate.push({ fn: fn.name, args });
      if (fn.name === "inspectLinkedInThreadPage") return probe;
      if (fn.name === "fetchLinkedInThreadApi" || fn.name === "fetchLinkedInConversationApi") {
        return responses.get(args[0]) || { error: "missing fixture" };
      }
      if (fn.name === "discoverOlderThreadApi") {
        return { api_url: "", message_list_found: true };
      }
      throw new Error(`Unexpected page function ${fn.name}`);
    },
  };
}

test("the command keeps every column it returns today and adds the sender participant id", () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  assert.ok(command);
  // Adding participant identifiers is additive: every column callers already
  // read (packages/core parses these rows) must survive.
  const established = [
    "thread_url",
    "thread_id",
    "conversation_name",
    "conversation_title",
    "conversation_is_group",
    "participant_count",
    "returned_index",
    "returned_message_count",
    "message_id",
    "sent_at",
    "sender_name",
    "sender_type",
    "sender_profile_url",
    "sender_headline",
    "sender_is_self",
    "text",
    "subject",
    "reaction_count",
    "is_latest",
  ];
  for (const column of established) {
    assert.ok(command.columns.includes(column), `dropped column ${column}`);
  }
  assert.ok(command.columns.includes("sender_participant_id"));
});

test("message rows carry the sender's bare participant id", () => {
  const rows = parseThreadMessagePayloads(
    [
      payload([
        message("m1", THREAD_ID, SELF, 1000, "first"),
        message("m2", THREAD_ID, EVAN, 2000, "second"),
      ]),
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );

  assert.equal(rows[0].sender_participant_id, "self");
  assert.equal(rows[1].sender_participant_id, "evan");
  // An unresolvable sender stays empty rather than inventing an id.
  const orphan = parseThreadMessagePayloads(
    [
      {
        included: [
          {
            $type: "com.linkedin.messenger.Conversation",
            entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
          },
          message("m1", THREAD_ID, "urn:li:msg_messagingParticipant:missing", 1000, "hi"),
        ],
      },
    ],
    { threadId: THREAD_ID, threadUrl: THREAD_URL, limit: 20 },
  );
  assert.equal(orphan[0].sender_participant_id, "");
});

test("the command returns one row per message from the requested thread", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  assert.ok(command);
  assert.equal(command.strategy, "cookie");
  assert.ok(command.columns.includes("sender_name"));
  assert.ok(command.columns.includes("sent_at"));
  const initial = apiUrl(THREAD_ID);
  const page = fakePage({
    probe: { current_url: THREAD_URL, auth_wall: false, initial_url: initial, page_urls: [] },
    responses: new Map([
      [
        initial,
        {
          json: payload([
            message("m1", THREAD_ID, SELF, 1000, "hello"),
            message("m2", THREAD_ID, EVAN, 2000, "hi"),
            message("m3", THREAD_ID, SELF, 3000, "Sunday?"),
          ]),
        },
      ],
    ]),
  });
  const rows = await command.func(page, { "thread-url": THREAD_URL, limit: 10 });

  assert.deepEqual(page.calls.goto, ["https://www.linkedin.com/messaging/", THREAD_URL]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["hello", "hi", "Sunday?"],
  );
  assert.ok(rows.every((row) => row.thread_id === THREAD_ID));
});

test("the command joins conversation metadata into sparse message responses", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const initial = apiUrl(THREAD_ID);
  const conversations = conversationApiUrl();
  const MIRA = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:mira";
  const metadata = payload([], [participant(MIRA, "Mira", "Chen", "DISTANCE_1", "Designer")], {
    groupChat: true,
  });
  const sparseMessages = sparseMessagePayload();
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [conversations],
    },
    responses: new Map([
      [conversations, { json: metadata }],
      [initial, { json: sparseMessages }],
    ]),
  });
  const rows = await command.func(page, { "thread-url": THREAD_URL, limit: 20 });

  assert.equal(rows[0].conversation_name, "Evan Ye, Mira Chen");
  assert.equal(rows[0].conversation_is_group, true);
  assert.equal(rows[0].participant_count, 3);
  assert.equal(
    page.calls.evaluate.find((call) => call.fn === "fetchLinkedInConversationApi")?.args[2],
    THREAD_ID,
  );
  assert.deepEqual(
    page.calls.evaluate
      .filter((call) => call.fn.startsWith("fetchLinkedIn"))
      .map((call) => [call.fn, call.args[0]]),
    [
      ["fetchLinkedInConversationApi", conversations],
      ["fetchLinkedInThreadApi", initial],
    ],
  );
});

test("the command continues to a later conversation URL after metadata failure", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const initial = apiUrl(THREAD_ID);
  const stale = conversationApiUrl(",syncToken:stale");
  const current = conversationApiUrl(",syncToken:current");
  const MIRA = "urn:li:msg_messagingParticipant:urn:li:fsd_profile:mira";
  const metadata = payload([], [participant(MIRA, "Mira", "Chen", "DISTANCE_1")], {
    groupChat: true,
  });
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [stale, current],
    },
    responses: new Map([
      [stale, { error: "HTTP 500" }],
      [current, { json: metadata }],
      [initial, { json: sparseMessagePayload() }],
    ]),
  });
  const rows = await command.func(page, { "thread-url": THREAD_URL, limit: 20 });

  assert.equal(rows[0].conversation_is_group, true);
  assert.equal(rows[0].participant_count, 3);
  assert.deepEqual(
    page.calls.evaluate
      .filter((call) => call.fn === "fetchLinkedInConversationApi")
      .map((call) => call.args[0]),
    [stale, current],
  );
});

test("the command returns messages when all optional metadata responses fail", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const initial = apiUrl(THREAD_ID);
  const failed = conversationApiUrl(",syncToken:failed");
  const malformed = conversationApiUrl(",syncToken:malformed");
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [failed, malformed],
    },
    responses: new Map([
      [failed, { error: "HTTP 500" }],
      [malformed, { json: {} }],
      [initial, { json: sparseMessagePayload("message survives") }],
    ]),
  });
  const rows = await command.func(page, { "thread-url": THREAD_URL, limit: 20 });

  assert.equal(rows[0].text, "message survives");
  assert.equal(rows[0].conversation_is_group, null);
  assert.equal(rows[0].participant_count, null);
  assert.ok(page.calls.evaluate.some((call) => call.fn === "fetchLinkedInThreadApi"));
});

test("the command combines observed API pages and keeps only the latest limit", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const initial = apiUrl(THREAD_ID);
  const older = apiUrl(THREAD_ID, true);
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [older],
    },
    responses: new Map([
      [
        initial,
        {
          json: payload([
            message("m3", THREAD_ID, EVAN, 3000, "third"),
            message("m4", THREAD_ID, SELF, 4000, "fourth"),
          ]),
        },
      ],
      [
        older,
        {
          json: payload([
            message("m1", THREAD_ID, SELF, 1000, "first"),
            message("m2", THREAD_ID, EVAN, 2000, "second"),
          ]),
        },
      ],
    ]),
  });
  const rows = await command.func(page, { "thread-url": THREAD_URL, limit: 3 });

  assert.deepEqual(
    rows.map((row) => row.text),
    ["second", "third", "fourth"],
  );
  assert.deepEqual(
    page.calls.evaluate
      .filter((call) => call.fn === "fetchLinkedInThreadApi")
      .map((call) => call.args[0]),
    [initial, older],
  );
});

test("the command validates inputs before navigation and fails closed on auth walls", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const invalid = fakePage({ probe: {}, responses: new Map() });
  await assert.rejects(
    command.func(invalid, { "thread-url": "https://www.linkedin.com/feed/", limit: 20 }),
    ArgumentError,
  );
  assert.deepEqual(invalid.calls.goto, []);

  const auth = fakePage({
    probe: { current_url: "https://www.linkedin.com/login", auth_wall: true },
    responses: new Map(),
  });
  await assert.rejects(
    command.func(auth, { "thread-url": THREAD_URL, limit: 20 }),
    AuthRequiredError,
  );
});

test("the command rejects malformed normalized API payloads", async () => {
  const command = getRegistry().get("linkedin/thread-snapshot");
  const initial = apiUrl(THREAD_ID);
  const page = fakePage({
    probe: { current_url: THREAD_URL, auth_wall: false, initial_url: initial, page_urls: [] },
    responses: new Map([[initial, { json: {} }]]),
  });
  await assert.rejects(
    command.func(page, { "thread-url": THREAD_URL, limit: 20 }),
    CommandExecutionError,
  );
});
