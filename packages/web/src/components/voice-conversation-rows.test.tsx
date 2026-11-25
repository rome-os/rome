// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { VoiceConversationRows } from "./voice-conversation-rows";

// The player a voice conversation plays its reply on: the test hears what reaches it.
const player = rs.hoisted(() => ({
  opened: 0,
  closed: 0,
  played: [] as Array<{ bytes: number; sampleRate: number }>,
}));
rs.mock("@/lib/voice-conversation/player", () => ({
  createPcmPlayer: () => {
    player.opened += 1;
    return {
      play: (chunk: ArrayBuffer, sampleRate: number) =>
        player.played.push({ bytes: chunk.byteLength, sampleRate }),
      clear: () => {},
      level: () => 0,
      ahead: () => 0.5,
      close: () => {
        player.closed += 1;
      },
    };
  },
}));

/** A WAV file of `samples` 16-bit samples at 24 kHz, as the preview answers. */
function wav(samples: number): Uint8Array {
  const out = new Uint8Array(44 + samples * 2);
  new DataView(out.buffer).setUint32(24, 24_000, true);
  return out;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  player.opened = 0;
  player.closed = 0;
  player.played = [];
});

/** Stands in for the voice conversation routes, and records what the rows asked of them. */
function serve(
  available = true,
  answer: {
    preview?: () => Promise<Response>;
    save?: () => Promise<void>;
    /** Holds a read after the first, answering what was saved when it was asked. */
    read?: () => Promise<void>;
  } = {},
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let settings = { voice: "Iris", speed: 1 };
  let reads = 0;
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
      if (method === "PUT") {
        await answer.save?.();
        settings = body;
        return Response.json(settings);
      }
      const asked = settings;
      reads += 1;
      if (reads > 1) await answer.read?.();
      return Response.json(asked);
    }
    if (path === "/api/voice-conversation/preview") {
      if (answer.preview) return answer.preview();
      return new Response(wav(240), { headers: { "Content-Type": "audio/wav" } });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <VoiceConversationRows />
    </QueryClientProvider>,
  );
  return { calls, view, client };
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
    const { calls } = serve();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation speed" }).textContent).toBe("1×"),
    );
    await user.click(screen.getByRole("combobox", { name: "Conversation speed" }));
    await user.click(screen.getByRole("option", { name: "1.3×" }));
    await waitFor(() => expect(player.played).not.toHaveLength(0));
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
    const { calls } = serve();
    const user = userEvent.setup();
    const field = () => screen.getByRole("combobox", { name: "Conversation voice" });
    await waitFor(() => expect(field().textContent).toBe("Iris"));
    await user.click(field());
    await user.click(screen.getByRole("option", { name: /Reid/ }));
    await waitFor(() => expect(player.played).not.toHaveLength(0));
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/voice-conversation/settings",
      body: { voice: "Reid", speed: 1 },
    });
    await waitFor(() => expect(field().textContent).toBe("Reid"));
  });

  it("plays a sample of the voice picked, and stops it", async () => {
    const { calls } = serve();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation voice" }).textContent).toContain(
        "Iris",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Play a sample" }));
    await waitFor(() => expect(player.played).not.toHaveLength(0));
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

describe("a sample in Settings", () => {
  it("plays on the player opened by the click, at the sample's own rate", async () => {
    serve();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation voice" }).textContent).toBe("Iris"),
    );
    await user.click(screen.getByRole("button", { name: "Play a sample" }));
    // Opened in the click itself, before the sample is in.
    expect(player.opened).toBe(1);
    await waitFor(() => expect(player.played).toEqual([{ bytes: 480, sampleRate: 24_000 }]));
  });

  it("stays silent when Settings is left while the sample still loads", async () => {
    let answer: (response: Response) => void = () => {};
    const { view } = serve(true, {
      preview: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation voice" }).textContent).toBe("Iris"),
    );
    await user.click(screen.getByRole("button", { name: "Play a sample" }));
    view.unmount();
    expect(player.closed).toBe(1);
    answer(new Response(wav(240)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(player.played).toEqual([]);
  });

  it("takes no new pick while one is saving, so an older save cannot replace it", async () => {
    let saved: () => void = () => {};
    serve(true, { save: () => new Promise<void>((resolve) => (saved = resolve)) });
    const user = userEvent.setup();
    const voice = () => screen.getByRole("combobox", { name: "Conversation voice" });
    const speed = () => screen.getByRole("combobox", { name: "Conversation speed" });
    await waitFor(() => expect(voice().textContent).toBe("Iris"));
    await user.click(voice());
    await user.click(screen.getByRole("option", { name: /Grace/ }));
    await waitFor(() => expect(voice().hasAttribute("disabled")).toBe(true));
    expect(speed().hasAttribute("disabled")).toBe(true);
    saved();
    await waitFor(() => expect(voice().hasAttribute("disabled")).toBe(false));
    expect(voice().textContent).toBe("Grace");
  });
});

describe("a save in Settings", () => {
  it("is not undone by a read that was already on its way", async () => {
    let answerRead: () => void = () => {};
    const { client } = serve(true, {
      read: () => new Promise<void>((resolve) => (answerRead = resolve)),
    });
    const user = userEvent.setup();
    const voice = () => screen.getByRole("combobox", { name: "Conversation voice" });
    await waitFor(() => expect(voice().textContent).toBe("Iris"));
    // A read begins, as when the window regains focus, and is slow to answer.
    void client.refetchQueries({ queryKey: ["voice-conversation", "settings"] });
    await user.click(voice());
    await user.click(screen.getByRole("option", { name: /Grace/ }));
    await waitFor(() => expect(voice().hasAttribute("disabled")).toBe(false));
    expect(voice().textContent).toBe("Grace");
    // The old read answers Iris now; the saved choice stays.
    answerRead();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(voice().textContent).toBe("Grace");
  });
});
