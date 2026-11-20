// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { TaskLinkDto } from "@rome/api-types/task-list";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import { taskChatOfLink, taskLink } from "@rome/api-types/task-link";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { ChatLink } from "../ChatLink";
import { TaskLinksScope } from "./task-links";

let known: TaskLinkDto[];
let asked: string[];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  known = [];
  asked = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://rome.test");
      asked.push(url.searchParams.get("ids") ?? "");
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return new Response(
        JSON.stringify({ tasks: known.filter((task) => ids.includes(task.id)) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const link = (id: string, text: string) => (
  <ChatLink href={taskLink(text, id).match(/\((.*)\)/)![1]}>{text}</ChatLink>
);

function renderLinks(children: React.ReactNode, chatId: string | null = "concierge") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <MemoryRouter>
          <TaskLinksScope chatId={chatId}>
            <p>{children}</p>
          </TaskLinksScope>
        </MemoryRouter>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>,
  );
}

describe("a task link in a Concierge message", () => {
  it("reads and builds the markdown link a Concierge writes", () => {
    expect(taskLink("Book flights", "chat-1")).toBe("[Book flights](#rome-task=chat-1)");
    expect(taskLink("A [rough] name", "a/b")).toBe("[A rough name](#rome-task=a%2Fb)");
    expect(taskChatOfLink("#rome-task=a%2Fb")).toBe("a/b");
    expect(taskChatOfLink("#rome-task=")).toBeNull();
    expect(taskChatOfLink("#rome-task=%E0%A4%A")).toBeNull();
    expect(taskChatOfLink("https://x.test/#rome-task=a")).toBeNull();
    expect(taskChatOfLink(undefined)).toBeNull();
  });

  it("draws the task chat's current name, not the link's text, and opens the chat", async () => {
    known = [
      {
        id: "chat-1",
        name: "Book direct flights",
        status: "active",
        endReason: null,
      },
    ];
    renderLinks(link("chat-1", "Book flights"));
    const chip = await screen.findByRole("link", { name: "Book direct flights, Active" });
    expect(chip.textContent).toBe("Book direct flights");
    expect(chip.getAttribute("href")).toBe("/chat/chat-1");
    // The status word is in the tooltip and the label, never on the chip.
    expect(chip.getAttribute("title")).toBe("Active");
    expect(chip.hasAttribute("data-task-link")).toBe(true);
    // Active draws the running ring.
    expect(chip.querySelector(".rome-status-spin")).toBeTruthy();
  });

  it.each([
    ["needs_you", null, "Needs you", "lucide-circle-alert"],
    ["later", null, "Later", "lucide-clock"],
    ["ended", "done", "Done", "lucide-circle-check"],
    ["ended", "failed", "Failed", "lucide-circle-x"],
    ["ended", "stopped", "Stopped", "lucide-circle-stop"],
    ["ended", "no_response", "No response", "lucide-circle"],
  ] as const)("marks a %s/%s task chat as %s", async (status, endReason, word, glyph) => {
    known = [{ id: "chat-1", name: "Taxes", status, endReason }];
    renderLinks(link("chat-1", "Taxes"));
    const chip = await screen.findByRole("link", { name: `Taxes, ${word}` });
    expect(chip.querySelector("svg")?.getAttribute("class")).toContain(glyph);
    expect(chip.textContent).toBe("Taxes");
  });

  it("reads as plain text for a foreign or unknown task chat, and outside a Concierge chat", async () => {
    // The chat this message is in knows no such task chat: another owner's, or none.
    known = [];
    renderLinks(<>See {link("someone-elses", "Their task")} now</>);
    await waitFor(() => expect(asked).toEqual(["someone-elses"]));
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
    expect(screen.getByText(/See Their task now/)).toBeTruthy();
    cleanup();

    // A chat that is no Concierge chat has none to ask.
    known = [{ id: "chat-1", name: "Taxes", status: "active", endReason: null }];
    asked = [];
    renderLinks(link("chat-1", "Taxes"), null);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Taxes")).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("asks once for every task chat a message names, and moves as the task chat runs", async () => {
    known = [
      { id: "a", name: "First", status: "active", endReason: null },
      { id: "b", name: "Second", status: "needs_you", endReason: null },
    ];
    renderLinks(
      <>
        {link("a", "First")} and {link("b", "Second")}
      </>,
    );
    await screen.findByRole("link", { name: "Second, Needs you" });
    expect(asked.at(-1)).toBe("a,b");
    // It finishes: the chip changes in place.
    known = [{ id: "a", name: "First", status: "ended", endReason: "done" }, known[1]!];
    act(() => {
      acceptLatestSocket().receive({
        type: "event",
        topic: chatTasksTopicName("concierge"),
        event: "tasks_changed",
        data: { chatId: "concierge" },
      });
    });
    expect(await screen.findByRole("link", { name: "First, Done" })).toBeTruthy();
  });

  it("draws a task of another of the owner's chats, and moves on this chat's changes", async () => {
    // Another chat's task: the server answers it, and this chat's topic carries
    // every change of its owner's tasks.
    known = [{ id: "agenda", name: "Agenda", status: "active", endReason: null }];
    renderLinks(link("agenda", "Agenda"));
    await screen.findByRole("link", { name: "Agenda, Active" });
    known = [{ ...known[0]!, status: "ended", endReason: "done" }];
    act(() => {
      acceptLatestSocket().receive({
        type: "event",
        topic: chatTasksTopicName("concierge"),
        event: "tasks_changed",
        data: { chatId: "concierge" },
      });
    });
    expect(await screen.findByRole("link", { name: "Agenda, Done" })).toBeTruthy();
  });
});
