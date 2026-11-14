import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatRow } from "@/components/chat/chat-view";
import type { LivePreview } from "@/components/chat/MessageList";
import { isRenderable, simulatedTypingMs } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";

const agentMessages = (rows: readonly ChatRow[]): ChatMessage[] =>
  rows.flatMap((row) =>
    row.kind === "agent" ? row.messages.filter((message) => isRenderable(message)) : [],
  );

/**
 * The typing dots of a turn the server marks `simulated`, whose provider
 * cannot say when it writes a message (docs/domains/chats.md#status-reaction):
 * each of the turn's messages that arrives while the chat is open waits
 * behind the dots for a moment, by its length, then shows. Several wait their
 * turn, one after the other. History, and a quiet turn's first message, never
 * wait. Answers the rows to draw, without the waiting messages, and whether
 * one waits.
 */
export function useSimulatedTyping(
  rows: ChatRow[],
  live: Pick<LivePreview, "isStreaming" | "runningTurnId" | "quiet" | "writing">,
): { rows: ChatRow[]; holding: boolean } {
  const seen = useRef<Set<string> | null>(null);
  const [held, setHeld] = useState<ReadonlyArray<{ id: string; ms: number }>>([]);

  // Before paint, so a message that waits never flashes in first.
  useLayoutEffect(() => {
    const messages = agentMessages(rows);
    // The first rows loaded are history.
    if (!seen.current) {
      if (rows.length > 0) seen.current = new Set(messages.map((message) => message.id));
      return;
    }
    const known = seen.current;
    const lastKnown = messages.findLastIndex((message) => known.has(message.id));
    // Rows that share no message with the ones before replace them, as a
    // reconnect's newest page does: history, which never waits. Before any
    // was seen, as in a new chat, the first reply is new, not a replacement.
    const replaced = known.size > 0 && lastKnown < 0;
    const waiting: { id: string; ms: number }[] = [];
    messages.forEach((message, index) => {
      if (known.has(message.id)) return;
      known.add(message.id);
      // Only a message that arrives after every one seen: no older page.
      if (replaced || index <= lastKnown) return;
      const writing = live.writing;
      if (writing?.mode !== "simulated" || message.turnId == null) return;
      // Only the running turn's own message, the one the server marked.
      const running = live.isStreaming ? live.runningTurnId : null;
      if (message.turnId !== writing.turnId && message.turnId !== running) return;
      // A quiet turn shows nothing until it has said something.
      const spokeBefore = messages
        .slice(0, index)
        .some((earlier) => earlier.turnId != null && earlier.turnId === message.turnId);
      if (live.quiet && !spokeBefore) return;
      waiting.push({ id: message.id, ms: simulatedTypingMs(message) });
    });
    if (waiting.length > 0) setHeld((current) => [...current, ...waiting]);
  }, [rows, live.isStreaming, live.runningTurnId, live.quiet, live.writing]);

  // The first waiting message shows once its time is up, and the next starts.
  const head = held[0];
  useEffect(() => {
    if (!head) return;
    const timer = window.setTimeout(() => setHeld((current) => current.slice(1)), head.ms);
    return () => window.clearTimeout(timer);
  }, [head]);

  const shown = useMemo(() => {
    if (held.length === 0) return rows;
    const hidden = new Set(held.map((entry) => entry.id));
    return rows.flatMap((row) => {
      if (row.kind !== "agent" || !row.messages.some((message) => hidden.has(message.id))) {
        return [row];
      }
      const messages = row.messages.filter((message) => !hidden.has(message.id));
      return messages.length > 0 ? [{ ...row, messages }] : [];
    });
  }, [rows, held]);
  return { rows: shown, holding: held.length > 0 };
}
