import {
  parseThreadMessagePayloads,
  parseThreadParticipantPayloads,
  validateThreadConversationPayload,
} from "./thread-snapshot-helpers.mjs";

export function verifiedReplyTarget(payload, { threadId, threadUrl, recipientId, selfId }) {
  if (
    !validateThreadConversationPayload(payload, threadId) ||
    payload.__opencli?.conversation_participant_refs_complete !== true
  ) {
    throw new Error("LinkedIn could not verify the complete conversation membership");
  }
  const conversation = payload.included.find(
    (entity) => entity.$type === "com.linkedin.messenger.Conversation",
  );
  const participants = parseThreadParticipantPayloads([payload], { threadId, threadUrl });
  if (
    conversation.groupChat !== false ||
    conversation["*conversationParticipants"]?.length !== 2 ||
    participants.length !== 2 ||
    !participants.some(
      (p) => p.participant_id === recipientId && !p.is_self && p.type === "member",
    ) ||
    !participants.some((p) => p.participant_id === selfId && p.is_self && p.type === "member")
  ) {
    throw new Error("LinkedIn conversation participants do not match the selected accounts");
  }
  const mailboxUrn = `urn:li:fsd_profile:${selfId}`;
  if (conversation.entityUrn !== `urn:li:msg_conversation:(${mailboxUrn},${threadId})`) {
    throw new Error("LinkedIn conversation does not belong to the selected sending account");
  }
  return { conversationUrn: conversation.entityUrn, mailboxUrn };
}

// Runs in the signed-in browser. The one POST addresses the verified conversation directly.
export async function postLinkedInReply(csrf, target, text, originToken, trackingId, threadUrl) {
  if (
    location.origin !== "https://www.linkedin.com" ||
    location.pathname !== new URL(threadUrl).pathname
  ) {
    return { error: "LinkedIn navigated away from the selected conversation" };
  }
  try {
    const response = await fetch(
      "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "csrf-token": csrf,
          "content-type": "application/json",
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "x-restli-protocol-version": "2.0.0",
        },
        body: JSON.stringify({
          message: {
            body: { attributes: [], text },
            renderContentUnions: [],
            conversationUrn: target.conversationUrn,
            originToken,
          },
          mailboxUrn: target.mailboxUrn,
          trackingId,
          dedupeByClientGeneratedToken: false,
        }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      return { auth_required: true };
    }
    if (!response.ok && response.status < 500)
      return { error: `LinkedIn rejected the reply (HTTP ${response.status})` };
    if (!response.ok) return { uncertain: true };
    return { json: await response.json() };
  } catch {
    return { uncertain: true };
  }
}

export const UNKNOWN_REPLY_OUTCOME = "Send outcome is unknown. Check LinkedIn before retrying.";

export function parseReplyReceipt(json, payload, { threadId, threadUrl, originToken }) {
  const messages = new Map();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$type === "com.linkedin.messenger.Message") {
      if (value.originToken !== originToken) return;
      // History prefers the backend id. Without it a receipt can name a different id later.
      if (
        typeof value.backendUrn === "string" &&
        value.backendUrn.startsWith("urn:li:messagingMessage:")
      ) {
        messages.set(value.backendUrn, value);
      }
      return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(json);
  const rows = parseThreadMessagePayloads(
    [{ included: [...payload.included, ...messages.values()] }],
    { threadId, threadUrl, limit: 100 },
  );
  if (rows.length !== 1 || !rows[0].sender_is_self || !rows[0].sent_at) {
    throw new Error(UNKNOWN_REPLY_OUTCOME);
  }
  return { ...rows[0], status: "sent" };
}

export async function confirmReplyReceipt(json, payload, expected, { readHistory, wait }) {
  try {
    return parseReplyReceipt(json, payload, expected);
  } catch {}

  // A lost or partial response can follow a successful send. Re-read, never re-send.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parseReplyReceipt(await readHistory(), payload, expected);
    } catch {}
    if (attempt < 2) await wait();
  }
  throw new Error(UNKNOWN_REPLY_OUTCOME);
}
