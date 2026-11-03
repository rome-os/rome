import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { channelLabel } from "./channel-meta";
import { sendRefusalKey } from "./send-copy";
import { usePeopleWrites } from "./use-writes";
import type { AccountRef } from "./writes";
import { randomUUID } from "@/lib/random-uuid";

/**
 * A send this page has asked for and the server has not answered for yet, or
 * one the channel refused. This page's own: the server keeps no record of a
 * send beyond its own copy of a message the channel took.
 */
export interface PendingSend extends AccountRef {
  /** This page's own key for the row, never sent. */
  id: string;
  text: string;
  state: "sending" | "failed";
  /** What stopped it, on a failed send: the channel's own words, or the reason
   *  the channel could not be written to. */
  error: string | null;
}

/** The sends this page has made and not yet seen answered. A send the channel
 *  took leaves, and its message shows on the timeline once the store that
 *  answers for the conversation has it; a failed one stays until the guardian
 *  retries or discards it. */
export function useConversationSends(personId: string) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [sends, setSends] = useState<PendingSend[]>([]);
  const active = useRef(new Set<string>());

  const patch = (id: string, change: Partial<PendingSend>) =>
    setSends((current) => current.map((send) => (send.id === id ? { ...send, ...change } : send)));

  function discard(id: string) {
    setSends((current) => current.filter((send) => send.id !== id));
  }

  async function attempt(id: string, account: AccountRef, text: string) {
    if (active.current.has(id)) return;
    active.current.add(id);
    patch(id, { state: "sending", error: null });
    try {
      const outcome = await writes.say(personId, account, text);
      if (outcome.ok) {
        discard(id);
        return;
      }
      const error =
        "conflict" in outcome
          ? t(sendRefusalKey(outcome.conflict.send), { channel: channelLabel(t, account.channel) })
          : outcome.message;
      patch(id, { state: "failed", error });
    } finally {
      active.current.delete(id);
    }
  }

  return {
    sends,
    send(account: AccountRef, text: string) {
      const id = randomUUID();
      const send: PendingSend = {
        id,
        channel: account.channel,
        channelUserId: account.channelUserId,
        text,
        state: "sending",
        error: null,
      };
      setSends((current) => [send, ...current]);
      void attempt(id, account, text);
    },
    retry(id: string) {
      const send = sends.find((candidate) => candidate.id === id);
      if (send?.state === "failed") void attempt(id, send, send.text);
    },
    discard,
  };
}
