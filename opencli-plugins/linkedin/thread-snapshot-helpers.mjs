export const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
export const DEFAULT_THREAD_MESSAGE_LIMIT = 20;
export const MAX_THREAD_MESSAGE_LIMIT = 100;

const THREAD_PATH_RE = /^\/messaging\/thread\/([^/]+)\/?$/i;
const PARTICIPANT_URN_PREFIX = "urn:li:msg_messagingParticipant:";
const MESSAGE_QUERY_RE = /[?&]queryId=messengerMessages\.[a-f0-9]+/i;
const CONVERSATION_QUERY_RE = /[?&]queryId=messengerConversations\.[a-f0-9]+/i;

export function normalizeThreadText(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u00a0\u202f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function unwrapThreadBrowserResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) {
    return payload.data;
  }
  return payload;
}

function isLinkedInHost(hostname) {
  const host = normalizeThreadText(hostname).toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

export function canonicalizeLinkedInThreadUrl(value) {
  const raw = normalizeThreadText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !isLinkedInHost(url.hostname)
    ) {
      return "";
    }
    const match = url.pathname.match(THREAD_PATH_RE);
    if (!match?.[1]) return "";
    url.hostname = "www.linkedin.com";
    url.hash = "";
    url.search = "";
    url.pathname = `/messaging/thread/${match[1]}/`;
    return url.toString();
  } catch {
    return "";
  }
}

export function linkedInThreadId(value) {
  const canonical = canonicalizeLinkedInThreadUrl(value);
  if (!canonical) return "";
  return new URL(canonical).pathname.match(THREAD_PATH_RE)?.[1] || "";
}

// A messaging participant urn nests the profile urn:
// `urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…`. The trailing
// segment is LinkedIn's obfuscated member id — the same `ACoAA…` that appears
// inside `profile_url` — and it is emitted bare so a caller can use it as a
// channel_user_id. Organization and agent participants nest their own urn the
// same way, so the trailing segment is their id too.
export function threadParticipantId(value) {
  let raw = normalizeThreadText(value);
  if (!raw) return "";
  if (raw.startsWith(PARTICIPANT_URN_PREFIX)) {
    raw = raw.slice(PARTICIPANT_URN_PREFIX.length).trim();
  }
  const decoded = decodeApiUrl(raw) || raw;
  const segments = decoded.split(":").filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  return last.replace(/^\(+/, "").replace(/\)+$/, "").trim();
}

export function normalizeThreadMessageLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_THREAD_MESSAGE_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_THREAD_MESSAGE_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_THREAD_MESSAGE_LIMIT}`);
  }
  return limit;
}

function decodeApiUrl(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function isThreadMessageApiUrl(value, threadId) {
  const raw = normalizeThreadText(value);
  const expectedThreadId = normalizeThreadText(threadId);
  if (!raw || !expectedThreadId || !MESSAGE_QUERY_RE.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.linkedin.com" ||
      url.pathname !== "/voyager/api/voyagerMessagingGraphQL/graphql"
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return decodeApiUrl(raw).includes(`,${expectedThreadId})`);
}

export function isThreadConversationApiUrl(value) {
  const raw = normalizeThreadText(value);
  if (!raw || !CONVERSATION_QUERY_RE.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.linkedin.com" &&
      url.pathname === "/voyager/api/voyagerMessagingGraphQL/graphql"
    );
  } catch {
    return false;
  }
}

export function selectThreadMessageApiUrls(values, threadId) {
  const matching = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeThreadText(value);
    if (!isThreadMessageApiUrl(url, threadId) || seen.has(url)) continue;
    seen.add(url);
    matching.push(url);
  }
  const initial = [...matching]
    .reverse()
    .find((url) => !/[,(]deliveredAt:\d+/i.test(decodeApiUrl(url)));
  return {
    initial_url: initial || "",
    page_urls: matching.filter((url) => /[,(]deliveredAt:\d+/i.test(decodeApiUrl(url))),
  };
}

function messageThreadId(message) {
  const backend = normalizeThreadText(message?.backendConversationUrn);
  if (backend.startsWith("urn:li:messagingThread:")) {
    return backend.slice("urn:li:messagingThread:".length);
  }
  const conversation = normalizeThreadText(message?.["*conversation"]);
  const match = conversation.match(/,([^,)]+)\)$/);
  return match?.[1] || "";
}

function conversationThreadId(conversation) {
  const backend = normalizeThreadText(conversation?.backendUrn);
  if (backend.startsWith("urn:li:messagingThread:")) {
    return backend.slice("urn:li:messagingThread:".length);
  }
  const entityUrn = normalizeThreadText(conversation?.entityUrn);
  const match = entityUrn.match(/,([^,)]+)\)$/);
  return match?.[1] || "";
}

function attributedText(value) {
  if (typeof value === "string") return normalizeThreadText(value);
  return normalizeThreadText(value?.text);
}

// `participant` is the normalized entity whose `entityUrn` is also the key of
// the participants map, so the identifier reaches the record without a second
// lookup.
function participantMetadata(participant) {
  return {
    participant_id: threadParticipantId(participant?.entityUrn),
    ...participantTypeMetadata(participant),
  };
}

function participantTypeMetadata(participant) {
  const type = participant?.participantType || {};
  if (type.member) {
    const member = type.member;
    return {
      name: normalizeThreadText(
        [attributedText(member.firstName), attributedText(member.lastName)]
          .filter(Boolean)
          .join(" "),
      ),
      type: "member",
      profile_url: normalizeThreadText(member.profileUrl),
      headline: attributedText(member.headline),
      is_self: member.distance === "SELF",
    };
  }
  if (type.organization) {
    return {
      name: attributedText(type.organization.name),
      type: "organization",
      profile_url: normalizeThreadText(type.organization.companyUrl || type.organization.url),
      headline: "",
      is_self: false,
    };
  }
  if (type.agent) {
    return {
      name: attributedText(type.agent.name),
      type: "agent",
      profile_url: normalizeThreadText(type.agent.profileUrl || type.agent.url),
      headline: "",
      is_self: false,
    };
  }
  if (type.custom) {
    return {
      name: attributedText(type.custom.name),
      type: "custom",
      profile_url: "",
      headline: "",
      is_self: false,
    };
  }
  return { name: "", type: "unknown", profile_url: "", headline: "", is_self: false };
}

function messageText(message) {
  return (
    attributedText(message?.body) ||
    attributedText(message?.renderContentFallbackText) ||
    attributedText(message?.subject)
  );
}

function reactionCount(message) {
  return (Array.isArray(message?.reactionSummaries) ? message.reactionSummaries : []).reduce(
    (total, reaction) => {
      const count = Number(reaction?.count ?? reaction?.totalCount ?? 0);
      return total + (Number.isFinite(count) && count > 0 ? count : 0);
    },
    0,
  );
}

function messageId(message) {
  const backend = normalizeThreadText(message?.backendUrn);
  if (backend.startsWith("urn:li:messagingMessage:")) {
    return backend.slice("urn:li:messagingMessage:".length);
  }
  return normalizeThreadText(message?.entityUrn);
}

export function countThreadMessagesInPayload(payload, threadId) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.included)) return 0;
  return payload.included.filter(
    (entity) =>
      entity?.$type === "com.linkedin.messenger.Message" && messageThreadId(entity) === threadId,
  ).length;
}

// The page-side fetch scopes before returning. Revalidation keeps unrelated inbox data out of the
// command result if that serialized function drifts or LinkedIn changes the response shape.
export function validateThreadConversationPayload(payload, threadId) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.included)) {
    throw new Error("LinkedIn messaging API returned a malformed normalized payload");
  }
  const conversations = payload.included.filter(
    (entity) => entity?.$type === "com.linkedin.messenger.Conversation",
  );
  if (conversations.length === 0) return null;
  if (conversations.length !== 1 || conversationThreadId(conversations[0]) !== threadId) {
    throw new Error("LinkedIn conversation API returned data for a different thread");
  }

  const conversation = conversations[0];
  const participantRefs = Array.isArray(conversation["*conversationParticipants"])
    ? conversation["*conversationParticipants"]
    : [];
  const participantRefSet = new Set(participantRefs);
  const hasUnrelatedEntity = payload.included.some(
    (entity) =>
      entity !== conversation &&
      !(
        entity?.$type === "com.linkedin.messenger.MessagingParticipant" &&
        participantRefSet.has(entity.entityUrn)
      ),
  );
  if (hasUnrelatedEntity) {
    throw new Error("LinkedIn conversation API returned unrelated conversation data");
  }
  return payload;
}

export function deriveConversationIsGroup(groupChat, completeParticipantRefs, counterpartyNames) {
  if (typeof groupChat === "boolean") return groupChat;
  if (Array.isArray(completeParticipantRefs)) return completeParticipantRefs.length > 2;
  if (counterpartyNames.length > 1) return true;
  return null;
}

// Both thread reads need the same view of a thread: every participant the
// payloads mention, the conversation's own metadata, and the authoritative
// participant-ref list when one arrived complete.
function collectThreadEntities(payloads, threadId) {
  const entities = [];
  const completeParticipantRefCandidates = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.included)) {
      throw new Error("LinkedIn messaging API returned a malformed normalized payload");
    }
    entities.push(...payload.included);
    if (payload.__opencli?.conversation_participant_refs_complete === true) {
      const conversation = payload.included.find(
        (entity) =>
          entity?.$type === "com.linkedin.messenger.Conversation" &&
          conversationThreadId(entity) === threadId,
      );
      const refs = Array.isArray(conversation?.["*conversationParticipants"])
        ? [
            ...new Set(
              conversation["*conversationParticipants"].map(normalizeThreadText).filter(Boolean),
            ),
          ]
        : [];
      if (refs.length >= 2) completeParticipantRefCandidates.push(refs);
    }
  }

  const participants = new Map();
  let conversationTitle = "";
  let conversationGroupChat = null;
  for (const entity of entities) {
    if (entity?.$type === "com.linkedin.messenger.MessagingParticipant" && entity.entityUrn) {
      participants.set(entity.entityUrn, participantMetadata(entity));
    }
    if (
      entity?.$type === "com.linkedin.messenger.Conversation" &&
      conversationThreadId(entity) === threadId
    ) {
      conversationTitle ||= normalizeThreadText(entity.title);
      if (conversationGroupChat === null && typeof entity.groupChat === "boolean") {
        conversationGroupChat = entity.groupChat;
      }
    }
  }
  const completeParticipantRefs = completeParticipantRefCandidates
    .filter(
      (refs) =>
        refs.every((ref) => participants.has(ref)) &&
        refs.some((ref) => participants.get(ref)?.is_self),
    )
    .sort((left, right) => right.length - left.length)[0];
  const conversationParticipants = completeParticipantRefs
    ? completeParticipantRefs.map((ref) => participants.get(ref)).filter(Boolean)
    : [...participants.values()];
  return {
    entities,
    participants,
    conversationParticipants,
    completeParticipantRefs,
    conversationTitle,
    conversationGroupChat,
  };
}

export function parseThreadParticipantPayloads(payloads, { threadId, threadUrl }) {
  const { conversationParticipants } = collectThreadEntities(payloads, threadId);
  // A complete participant-ref list carries everyone on the thread, including
  // members who never sent a message; message payloads alone only prove senders.
  const rows = [];
  const seen = new Set();
  for (const participant of conversationParticipants) {
    const participantId = participant?.participant_id || "";
    if (!participantId || seen.has(participantId)) continue;
    seen.add(participantId);
    rows.push({
      thread_url: threadUrl,
      thread_id: threadId,
      participant_id: participantId,
      name: participant.name,
      headline: participant.headline,
      type: participant.type,
      is_self: participant.is_self,
      profile_url: participant.profile_url,
    });
  }
  return rows.map((row, index) => ({
    ...row,
    participant_index: index + 1,
    participant_count: rows.length,
  }));
}

export function parseThreadMessagePayloads(payloads, { threadId, threadUrl, limit }) {
  const {
    entities,
    participants,
    conversationParticipants,
    completeParticipantRefs,
    conversationTitle,
    conversationGroupChat,
  } = collectThreadEntities(payloads, threadId);
  const counterpartyNames = [
    ...new Set(
      conversationParticipants
        .filter((participant) => !participant.is_self && participant.name)
        .map((participant) => participant.name),
    ),
  ];
  // conversation_name stays the display ladder (title, else joined counterparty
  // names) — so it is NOT a group discriminator: a 1:1 thread carries the
  // counterparty's name here. Group-ness is the API's own `groupChat` flag. A
  // complete participant-ref list can supply the fallback. Sparse message
  // payloads can prove a group, but they cannot prove a 1:1.
  const conversationName = conversationTitle || counterpartyNames.join(", ");
  const conversationIsGroup = deriveConversationIsGroup(
    conversationGroupChat,
    completeParticipantRefs,
    counterpartyNames,
  );
  const participantCount = completeParticipantRefs?.length ?? null;

  const messagesById = new Map();
  for (const entity of entities) {
    if (
      entity?.$type !== "com.linkedin.messenger.Message" ||
      messageThreadId(entity) !== threadId
    ) {
      continue;
    }
    const id = messageId(entity);
    if (!id || messagesById.has(id)) continue;
    const senderRef = normalizeThreadText(entity["*sender"] || entity["*actor"]);
    const sender = participants.get(senderRef) || participantMetadata(null);
    const deliveredAt = Number(entity.deliveredAt || 0);
    messagesById.set(id, {
      thread_url: threadUrl,
      thread_id: threadId,
      conversation_name: conversationName,
      conversation_title: conversationTitle,
      conversation_is_group: conversationIsGroup,
      participant_count: participantCount,
      message_id: id,
      sent_at:
        Number.isFinite(deliveredAt) && deliveredAt > 0 ? new Date(deliveredAt).toISOString() : "",
      sender_participant_id: sender.participant_id,
      sender_name: sender.name,
      sender_type: sender.type,
      sender_profile_url: sender.profile_url,
      sender_headline: sender.headline,
      sender_is_self: sender.is_self,
      text: messageText(entity),
      subject: attributedText(entity.subject),
      reaction_count: reactionCount(entity),
      delivered_at_ms: Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : 0,
    });
  }

  const sorted = [...messagesById.values()].sort(
    (left, right) =>
      left.delivered_at_ms - right.delivered_at_ms ||
      left.message_id.localeCompare(right.message_id),
  );
  const selected = sorted.slice(-limit);
  return selected.map(({ delivered_at_ms: _deliveredAtMs, ...message }, index) => ({
    ...message,
    returned_index: index + 1,
    returned_message_count: selected.length,
    is_latest: index === selected.length - 1,
  }));
}

// Runs in the LinkedIn page. Keep this function self-contained because OpenCLI serializes it.
export function inspectLinkedInThreadPage(threadId) {
  const clean = (value) =>
    typeof value === "string"
      ? value
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const bodyText = clean(document.body?.innerText || "");
  const authWall =
    /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(location.href) ||
    /\b(?:sign in|log in|join linkedin|captcha|verification required)\b/i.test(
      `${document.title || ""}\n${bodyText.slice(0, 4000)}`,
    );
  const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
  const matching = [];
  const conversationUrls = [];
  const seen = new Set();
  const seenConversationUrls = new Set();
  for (const raw of resources) {
    if (/[?&]queryId=messengerConversations\.[a-f0-9]+/i.test(raw)) {
      try {
        const url = new URL(raw);
        if (
          url.protocol === "https:" &&
          url.hostname === "www.linkedin.com" &&
          url.pathname === "/voyager/api/voyagerMessagingGraphQL/graphql" &&
          !seenConversationUrls.has(raw)
        ) {
          seenConversationUrls.add(raw);
          conversationUrls.push(raw);
        }
      } catch {}
    }
    if (!/[?&]queryId=messengerMessages\.[a-f0-9]+/i.test(raw)) continue;
    let parsed;
    let decoded;
    try {
      parsed = new URL(raw);
      decoded = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "www.linkedin.com" ||
      parsed.pathname !== "/voyager/api/voyagerMessagingGraphQL/graphql" ||
      !decoded.includes(`,${threadId})`) ||
      seen.has(raw)
    ) {
      continue;
    }
    seen.add(raw);
    matching.push(raw);
  }
  const initial = [...matching]
    .reverse()
    .find((url) => !/[,(]deliveredAt:\d+/i.test(decodeURIComponent(url)));
  return {
    current_url: location.href,
    auth_wall: authWall,
    initial_url: initial || "",
    page_urls: matching.filter((url) => /[,(]deliveredAt:\d+/i.test(decodeURIComponent(url))),
    conversation_urls: conversationUrls,
  };
}

// Runs in the LinkedIn page. The URL comes from the page's own Performance API.
export async function fetchLinkedInThreadApi(apiUrl, csrf) {
  try {
    const url = new URL(apiUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.linkedin.com" ||
      url.pathname !== "/voyager/api/voyagerMessagingGraphQL/graphql" ||
      !/[?&]queryId=messengerMessages\.[a-f0-9]+/i.test(url.toString())
    ) {
      return { error: "unsafe messaging API URL" };
    }
    const response = await fetch(url.toString(), {
      credentials: "include",
      cache: "no-store",
      headers: {
        "csrf-token": csrf,
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "x-restli-protocol-version": "2.0.0",
      },
    });
    if (response.status === 401 || response.status === 403) {
      return { auth_required: true, error: `HTTP ${response.status}` };
    }
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { json: await response.json() };
  } catch (error) {
    return { error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Runs in-page. Only the target conversation and its referenced participants cross the boundary.
export async function fetchLinkedInConversationApi(apiUrl, csrf, threadId) {
  try {
    const url = new URL(apiUrl);
    const expectedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (
      !expectedThreadId ||
      url.protocol !== "https:" ||
      url.hostname !== "www.linkedin.com" ||
      url.pathname !== "/voyager/api/voyagerMessagingGraphQL/graphql" ||
      !/[?&]queryId=messengerConversations\.[a-f0-9]+/i.test(url.toString())
    ) {
      return { error: "unsafe conversation API URL" };
    }
    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        "csrf-token": csrf,
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "x-restli-protocol-version": "2.0.0",
      },
    });
    if (response.status === 401 || response.status === 403) {
      return { auth_required: true, error: `HTTP ${response.status}` };
    }
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const json = await response.json();
    if (!Array.isArray(json?.included)) return { json };
    const conversation = json.included.find((entity) => {
      if (entity?.$type !== "com.linkedin.messenger.Conversation") return false;
      const backend = typeof entity.backendUrn === "string" ? entity.backendUrn.trim() : "";
      if (backend.startsWith("urn:li:messagingThread:")) {
        return backend.slice("urn:li:messagingThread:".length) === expectedThreadId;
      }
      const entityUrn = typeof entity.entityUrn === "string" ? entity.entityUrn.trim() : "";
      return entityUrn.match(/,([^,)]+)\)$/)?.[1] === expectedThreadId;
    });
    if (!conversation) {
      return {
        json: {
          included: [],
          __opencli: { conversation_participant_refs_complete: false },
        },
      };
    }
    const participantRefs = Array.isArray(conversation["*conversationParticipants"])
      ? [
          ...new Set(
            conversation["*conversationParticipants"]
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .filter(Boolean),
          ),
        ]
      : [];
    const participantRefSet = new Set(participantRefs);
    const participants = json.included.filter(
      (entity) =>
        entity?.$type === "com.linkedin.messenger.MessagingParticipant" &&
        participantRefSet.has(entity.entityUrn),
    );
    const includesSelf = participants.some(
      (participant) => participant?.participantType?.member?.distance === "SELF",
    );
    return {
      json: {
        included: [conversation, ...participants],
        __opencli: {
          conversation_participant_refs_complete:
            participantRefs.length >= 2 &&
            participants.length === participantRefs.length &&
            includesSelf,
        },
      },
    };
  } catch (error) {
    return { error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Runs in the LinkedIn page. It scrolls only the active thread pane and returns a new page URL.
export async function discoverOlderThreadApi(threadId, knownUrls) {
  const sleep = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
  const known = new Set(Array.isArray(knownUrls) ? knownUrls : []);
  const matchingUrls = () => {
    const result = [];
    for (const entry of performance.getEntriesByType("resource")) {
      const raw = entry.name;
      if (!/[?&]queryId=messengerMessages\.[a-f0-9]+/i.test(raw)) continue;
      try {
        const url = new URL(raw);
        const decoded = decodeURIComponent(raw);
        if (
          url.protocol === "https:" &&
          url.hostname === "www.linkedin.com" &&
          url.pathname === "/voyager/api/voyagerMessagingGraphQL/graphql" &&
          decoded.includes(`,${threadId})`) &&
          /[,(]deliveredAt:\d+/i.test(decoded) &&
          !known.has(raw)
        ) {
          result.push(raw);
        }
      } catch {}
    }
    return result;
  };

  const existing = matchingUrls();
  if (existing.length > 0) return { api_url: existing[0], message_list_found: true };
  const messageList = document.querySelector(".msg-thread .msg-s-message-list");
  if (!messageList) return { api_url: "", message_list_found: false };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    messageList.scrollTop = 0;
    messageList.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(500);
    const urls = matchingUrls();
    if (urls.length > 0) return { api_url: urls[0], message_list_found: true };
  }
  return { api_url: "", message_list_found: true };
}
