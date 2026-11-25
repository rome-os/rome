// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { VoiceConversationRows } from "./voice-conversation-rows";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

/** Stands in for the voice conversation routes, and records what the rows asked of them. */
function serve(available = true) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let settings = { voice: "Iris", speed: 1 };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const path = new URL(String(input), "http://rome.test").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/voice-conversation") return Response.json({ available });
    if (path === "/api/voice-conversation/settings") {
      if (method === "PUT") settings = body;
      return Response.json(settings);
    }
    if (path === "/api/voice-conversation/preview") {
      return new Response(new Uint8Array(44), { headers: { "Content-Type": "audio/wav" } });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  URL.createObjectURL = rs.fn(() => "blob:sample");
  URL.revokeObjectURL = rs.fn();
  const played = rs.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  rs.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VoiceConversationRows />
    </QueryClientProvider>,
  );
  return { calls, played };
}

describe("the voice conversation rows in Settings", () => {
  it("shows the voice and speed Rome speaks in", async () => {
    serve();
    expect(await screen.findByText("Conversation voice")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation voice" }).textContent).toContain(
        "Iris",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Conversation speed" }).textContent).toBe("1×");
  });

  it("keeps a new speed and plays the voice at it", async () => {
    const { calls, played } = serve();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation speed" }).textContent).toBe("1×"),
    );
    await user.click(screen.getByRole("combobox", { name: "Conversation speed" }));
    await user.click(screen.getByRole("option", { name: "1.3×" }));
    await waitFor(() => expect(played).toHaveBeenCalled());
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/voice-conversation/settings",
      body: { voice: "Iris", speed: 1.3 },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/voice-conversation/preview",
      body: { voice: "Iris", speed: 1.3, language: "en" },
    });
  });

  it("keeps a picked voice and plays it, naming only the voice in the field", async () => {
    const { calls, played } = serve();
    const user = userEvent.setup();
    const field = () => screen.getByRole("combobox", { name: "Conversation voice" });
    await waitFor(() => expect(field().textContent).toBe("Iris"));
    await user.click(field());
    await user.click(screen.getByRole("option", { name: /Reid/ }));
    await waitFor(() => expect(played).toHaveBeenCalled());
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/voice-conversation/settings",
      body: { voice: "Reid", speed: 1 },
    });
    await waitFor(() => expect(field().textContent).toBe("Reid"));
  });

  it("plays a sample of the voice picked, and stops it", async () => {
    const { calls, played } = serve();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation voice" }).textContent).toContain(
        "Iris",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Play a sample" }));
    await waitFor(() => expect(played).toHaveBeenCalled());
    expect(calls.filter((call) => call.path.endsWith("/preview"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop the sample" }));
    expect(screen.getByRole("button", { name: "Play a sample" })).toBeTruthy();
  });

  it("shows nothing where no voice conversation is offered", async () => {
    const { calls } = serve(false);
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/voice-conversation")).toBe(true),
    );
    expect(screen.queryByText("Conversation voice")).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/settings"))).toBe(false);
  });
});
