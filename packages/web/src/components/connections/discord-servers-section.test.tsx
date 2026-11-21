// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { DiscordServersSection } from "@/components/connections/discord-servers-section";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const LISTED = {
  servers: [{ serverId: "5", serverName: "Ray's Lab", createdAt: 1 }],
  users: [{ userId: "700000000000000007", createdAt: 2, name: "Ray" }],
};

function answering(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    const handler = handlers[key];
    return handler ? handler() : new Response(null, { status: 404 });
  }) as typeof fetch);
  return calls;
}

describe("the servers Rome's Discord bot was added to", () => {
  it("lists each server and the guardian's accounts", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
    });
    render(<DiscordServersSection />);
    expect(await screen.findByText("Ray's Lab")).toBeTruthy();
    expect(screen.getByText("Ray")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to server" })).toBeTruthy();
  });

  it("removes a server and reads the list again", async () => {
    const calls = answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
      "DELETE /api/connections/discord-app/servers/5": () =>
        Response.json({ removed: true, left: true }),
    });
    render(<DiscordServersSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.startsWith("GET")).length).toBeGreaterThan(1),
    );
    expect(calls).toContain("DELETE /api/connections/discord-app/servers/5");
  });

  it("says when the list cannot be read, with a way to try again", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => new Response(null, { status: 502 }),
    });
    render(<DiscordServersSection />);
    expect(await screen.findByText("Couldn't load your servers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("opens Discord's page for Add to server in a new tab", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => Response.json({ servers: [], users: [] }),
      "POST /api/connections/discord-app/install-link": () =>
        Response.json({ url: "https://discord.com/oauth2/authorize?x=1" }),
    });
    const tab = { opener: {}, location: { href: "" }, close: rs.fn() };
    rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<DiscordServersSection />);
    expect(await screen.findByText(/Add Rome to a server you manage/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to server" }));
    await waitFor(() => expect(tab.location.href).toBe("https://discord.com/oauth2/authorize?x=1"));
    expect(tab.opener).toBeNull();
  });
});
