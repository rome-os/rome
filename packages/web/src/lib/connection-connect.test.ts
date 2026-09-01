import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { runComposioLogin, runComposioLogout } from "@/lib/connection-connect";

// Connect and reconnect run through the conferral setup (`useSetup`), while
// disconnect is a registry-native grant revoke. Only the Composio account
// ceremonies remain here.

describe("runComposioLogin — endpoint contracts", () => {
  const fetchMock = rs.fn();

  beforeEach(() => {
    rs.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    rs.unstubAllGlobals();
  });

  it("returns the loginUrl and resolves ok after the status poll confirms login", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ loginUrl: "https://composio/login" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ composio: { installed: true, loggedIn: true, loginPending: false } }),
          { status: 200 },
        ),
      );

    const capturedUrls: string[] = [];
    const result = await runComposioLogin({
      onLoginUrl: (url) => capturedUrls.push(url),
      sleep: () => Promise.resolve(),
      maxTries: 3,
    });

    expect(result).toEqual({ ok: true });
    expect(capturedUrls).toEqual(["https://composio/login"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/composio/login", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/composio/status", {
      cache: "no-store",
    });
  });

  it("returns an error when the login endpoint fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "CLI not found" }), { status: 500 }),
    );

    const result = await runComposioLogin({ sleep: () => Promise.resolve(), maxTries: 1 });
    expect(result).toEqual({ ok: false, error: "CLI not found" });
  });

  it("fails fast when the status poll surfaces a completion error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ loginUrl: "https://composio/login" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            composio: {
              installed: true,
              loggedIn: false,
              loginPending: false,
              error: "Composio login --poll exited (code 1) without saving credentials.",
            },
          }),
          { status: 200 },
        ),
      );

    const result = await runComposioLogin({ sleep: () => Promise.resolve(), maxTries: 5 });
    expect(result).toEqual({
      ok: false,
      error: "Composio login --poll exited (code 1) without saving credentials.",
    });
    // Should stop at the first errored status, not poll out all 5 tries.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns ok (unconfirmed) when polling times out", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ loginUrl: "https://composio/login" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({ composio: { installed: true, loggedIn: false, loginPending: true } }),
          { status: 200 },
        ),
      );

    const result = await runComposioLogin({ sleep: () => Promise.resolve(), maxTries: 2 });
    expect(result).toEqual({ ok: true });
  });
});

describe("runComposioLogout — endpoint contracts", () => {
  const fetchMock = rs.fn();

  beforeEach(() => {
    rs.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    rs.unstubAllGlobals();
  });

  it("POSTs to the logout endpoint and returns ok on success", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await runComposioLogout();
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/composio/logout", { method: "POST" });
  });

  it("surfaces the server error on failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "logout failed" }), { status: 500 }),
    );

    const result = await runComposioLogout();
    expect(result).toEqual({ ok: false, error: "logout failed" });
  });
});
