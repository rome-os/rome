import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OutboxMessage } from "@rome/api-types/people";
import { channelLabel } from "./channel-meta";
import { sendRefusalKey } from "./send-copy";
import { usePeopleWrites } from "./use-writes";
import type { AccountRef } from "./writes";

interface LocalSend {
  id: string;
  message: OutboxMessage;
}

/** Local requests join the server outbox without changing its cached rows or counts.
 * Accepted requests retain the server id until the refreshed reads settle. */
export function useConversationSends(personId: string, serverMessages: readonly OutboxMessage[]) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [requests, setRequests] = useState<LocalSend[]>([]);
  const active = useRef(new Set<string>());

  useEffect(() => {
    const serverIds = new Set(serverMessages.map((message) => message.id));
    if (serverIds.size === 0) return;
    // Once a read observes the row, polling owns it even if the POST response
    // is still in flight. A later delivery must not reveal its local copy again.
    setRequests((current) => {
      const remaining = current.filter((request) => !serverIds.has(request.id));
      return remaining.length === current.length ? current : remaining;
    });
  }, [serverMessages]);

  function discard(id: string) {
    setRequests((current) => current.filter((request) => request.id !== id));
  }

  async function attempt(id: string, account: AccountRef, text: string) {
    if (active.current.has(id)) return;
    active.current.add(id);
    setRequests((current) =>
      current.map((request) =>
        request.id === id
          ? { ...request, message: { ...request.message, state: "sending", error: null } }
          : request,
      ),
    );
    try {
      const outcome = await writes.say(personId, account, text, {
        id,
        onAccepted: (message) => {
          // Keep the server's answer visible while the refreshed reads settle.
          setRequests((current) =>
            current.map((request) => (request.id === id ? { ...request, message } : request)),
          );
        },
      });
      if (outcome.ok) {
        discard(id);
        return;
      }
      const error =
        "conflict" in outcome
          ? t(sendRefusalKey(outcome.conflict.send), { channel: channelLabel(t, account.channel) })
          : outcome.message;
      setRequests((current) =>
        current.map((request) =>
          request.id === id
            ? { ...request, message: { ...request.message, state: "failed", error } }
            : request,
        ),
      );
    } finally {
      active.current.delete(id);
    }
  }

  return {
    messages: requests.map((request) => request.message),
    send(account: AccountRef, text: string) {
      const id = crypto.randomUUID();
      const message: OutboxMessage = {
        id,
        channel: account.channel,
        channelUserId: account.channelUserId,
        text,
        timestamp: Math.floor(Date.now() / 1000),
        state: "sending",
        ref: null,
        error: null,
      };
      setRequests((current) => [{ id, message }, ...current]);
      void attempt(id, account, text);
    },
    retry(id: string) {
      const request = requests.find((candidate) => candidate.id === id);
      if (request?.message.state === "failed") {
        void attempt(id, request.message, request.message.text);
      }
    },
    discard,
  };
}
