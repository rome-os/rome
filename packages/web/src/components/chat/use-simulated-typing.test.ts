// @rstest-environment jsdom
import { describe, expect, it } from "@rstest/core";
import { renderHook } from "@testing-library/react";
import type { ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";
import { useSimulatedTyping } from "./use-simulated-typing";

const message = (id: string, role: ChatMessage["role"], turnId: string | null): ChatMessage => ({
  id,
  sessionId: "s1",
  turnId,
  role,
  content: JSON.stringify([{ type: "text", content: `message ${id}` }]),
  createdAt: "2026-11-13T00:00:00.000Z",
});

const userRow = (owner: ChatMessage): ChatRow =>
  ({ kind: "user", key: owner.id, message: owner }) as ChatRow;

const agentRow = (...messages: ChatMessage[]): ChatRow =>
  ({
    kind: "agent",
    key: messages[0]!.id,
    identity: {},
    trace: null,
    messages,
  }) as unknown as ChatRow;

const agentIds = (rows: ChatRow[]) =>
  rows.flatMap((row) => (row.kind === "agent" ? row.messages.map((m) => m.id) : []));

const live = {
  isStreaming: true,
  runningTurnId: "t1",
  quiet: false,
  writing: { sessionId: "s1", turnId: "t1", mode: "simulated" as const, writing: true },
};

describe("useSimulatedTyping", () => {
  it("holds a new chat's first reply behind the dots", () => {
    const owner = message("u1", "user", "t1");
    const { result, rerender } = renderHook(({ rows }) => useSimulatedTyping(rows, live), {
      initialProps: { rows: [userRow(owner)] },
    });
    rerender({ rows: [userRow(owner), agentRow(message("a1", "assistant", "t1"))] });
    expect(result.current.holding).toBe(true);
    expect(agentIds(result.current.rows)).toEqual([]);
  });

  it("shows rows that replace every agent message seen at once", () => {
    const first = [agentRow(message("a0", "assistant", "t0"))];
    const { result, rerender } = renderHook(({ rows }) => useSimulatedTyping(rows, live), {
      initialProps: { rows: first },
    });
    rerender({ rows: [agentRow(message("a1", "assistant", "t1"))] });
    expect(result.current.holding).toBe(false);
    expect(agentIds(result.current.rows)).toEqual(["a1"]);
  });
});
