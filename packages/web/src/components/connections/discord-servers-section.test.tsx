// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  servers: [
    {
      serverId: "5",
      serverName: "Ray's Lab",
      serverIcon: "https://cdn.discordapp.com/icons/5/abc.png?size=96",
      createdAt: 1,
    },
  ],
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

const section = (onDisconnect = () => {}) =>
  render(<DiscordServersSection onDisconnect={onDisconnect} disconnecting={false} />);

/** Opens the "…" menu of the tile named `name`. */
async function openMenuOf(name: string) {
  const tile = (await screen.findByText(name)).closest("[data-slot=card]") as HTMLElement;
  const trigger = within(tile).getByRole("button", { name: "More" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByRole("menu");
}

describe("the servers Rome's Discord bot was added to", () => {
  it("lists each server and the guardian's account", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
    });
    section();
    expect(await screen.findByText("Ray's Lab")).toBeTruthy();
    expect(screen.getByText("Linked as Ray · DM Rome, or @Rome in a channel.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to server" })).toBeTruthy();
  });

  it("removes a server from its menu and reads the list again", async () => {
    const calls = answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
      "DELETE /api/connections/discord-app/servers/5": () =>
        Response.json({ removed: true, left: true }),
    });
    section();
    const menu = await openMenuOf("Ray's Lab");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.startsWith("GET")).length).toBeGreaterThan(1),
    );
    expect(calls).toContain("DELETE /api/connections/discord-app/servers/5");
  });

  it("disconnects Discord from the bottom of the page", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
    });
    const onDisconnect = rs.fn();
    section(onDisconnect);
    await screen.findByText("Ray's Lab");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Discord" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("says when the list cannot be read, with a way to try again", async () => {
    answering({
      "GET /api/connections/discord-app/servers": () => new Response(null, { status: 502 }),
    });
    section();
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
    section();
    expect(await screen.findByText(/Add Rome to a server to @mention it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to server" }));
    await waitFor(() => expect(tab.location.href).toBe("https://discord.com/oauth2/authorize?x=1"));
    expect(tab.opener).toBeNull();
  });

  it("hands Add to server to the system browser in the Mac app", async () => {
    window.rome = {};
    answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
      "POST /api/connections/discord-app/install-link": () =>
        Response.json({ url: "https://discord.com/oauth2/authorize?x=2" }),
    });
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    section();
    fireEvent.click(await screen.findByRole("button", { name: "Add to server" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://discord.com/oauth2/authorize?x=2"),
    );
    expect(open).not.toHaveBeenCalledWith("", "_blank");
    delete window.rome;
  });

  it("reads the list again on coming back from Discord, and not on any other focus", async () => {
    const calls = answering({
      "GET /api/connections/discord-app/servers": () => Response.json(LISTED),
      "POST /api/connections/discord-app/install-link": () =>
        Response.json({ url: "https://discord.com/oauth2/authorize?x=3" }),
    });
    const reads = () => calls.filter((call) => call.startsWith("GET")).length;
    // Long after any trip to Discord: a focus reads nothing.
    const now = rs.spyOn(Date, "now").mockReturnValue(Date.UTC(2100, 0, 1));
    section();
    await screen.findByText("Ray's Lab");
    fireEvent.focus(window);
    expect(reads()).toBe(1);
    now.mockRestore();
    // Back from Discord's page: the list is read again.
    const tab = { opener: {}, location: { href: "" }, close: rs.fn() };
    rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    fireEvent.click(screen.getByRole("button", { name: "Add to server" }));
    await waitFor(() => expect(tab.location.href).toContain("x=3"));
    fireEvent.focus(window);
    await waitFor(() => expect(reads()).toBe(2));
  });
});
