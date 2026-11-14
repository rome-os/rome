import { describe, expect, it } from "@rstest/core";
import { conciergeOpenTasks } from "./open-tasks.js";

const task = (id: string, title: string, chatId: string, extra: Record<string, unknown> = {}) => ({
  row: { id, title, summary: null, sessionId: `chat-${id}`, ...extra },
  chat: { id: `chat-${id}`, name: title },
  conciergeChat: { id: chatId, name: "Main chat", main: true },
  owner: "guardian",
  sourceMessageId: null,
});

function service(statuses: Record<string, { status: string; laterAt?: number | null }>) {
  const rows = [
    task("t1", "Flights", "main"),
    task("t2", "Hotels", "main", { summary: "Two options left" }),
    task("t3", "Visa", "main"),
    task("t4", "Elsewhere", "topic"),
  ];
  return {
    conciergeChat: async (chatId: string) => (chatId === "none" ? null : { id: chatId }),
    ownerOfChat: async () => "guardian",
    deps: {
      tasks: {
        repo: { listForAgent: async () => rows },
        statusOf: async (of: { id: string }[]) =>
          new Map(
            of.map((row) => [
              row.id,
              { endReason: null, laterAt: null, waitingSince: null, ...statuses[row.id] },
            ]),
          ),
      },
    },
  } as never;
}

describe("conciergeOpenTasks", () => {
  it("lists the chat's tasks that have not ended, by the status Rome derives", async () => {
    const due = Date.parse("2026-11-12T10:00:00Z");
    const open = await conciergeOpenTasks(
      service({
        t1: { status: "needs_you" },
        t2: { status: "later", laterAt: due },
        t3: { status: "ended" },
        t4: { status: "active" },
      }),
      "main",
    );
    expect(open).toBe(
      [
        "- t1 · Flights · needs_you · task chat chat-t1",
        "- t2 · Hotels · later · check due 2026-11-12T10:00:00.000Z · task chat chat-t2",
        "  Two options left",
      ].join("\n"),
    );
  });

  it("is null when every task ended, or for no Concierge chat", async () => {
    const ended = service({
      t1: { status: "ended" },
      t2: { status: "ended" },
      t3: { status: "ended" },
    });
    expect(await conciergeOpenTasks(ended, "main")).toBeNull();
    expect(await conciergeOpenTasks(service({}), "none")).toBeNull();
  });
});
