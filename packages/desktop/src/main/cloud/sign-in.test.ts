import { describe, expect, it, rs } from "@rstest/core";
import { computerPlatform, DESKTOP_CLIENT_ID, signInToRomeCloud } from "./sign-in";

const CLOUD = "https://romeos.cc";

function tokenFetch() {
  return rs.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ access_token: "romemob_token", token_type: "Bearer", device_session_id: "s1" }),
  );
}

function options(overrides: Partial<Parameters<typeof signInToRomeCloud>[0]> = {}) {
  return {
    cloudOrigin: CLOUD,
    deviceName: "Ray's MacBook",
    platform: "macos" as const,
    appVersion: "0.1.8",
    osVersion: "25.6.0",
    fetchImpl: tokenFetch() as unknown as typeof fetch,
    // Plays the browser: approve, then follow the redirect to loopback.
    openBrowser: async (raw: string) => {
      const url = new URL(raw);
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "one-time");
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", CLOUD);
      void fetch(callback);
    },
    ...overrides,
  };
}

describe("signInToRomeCloud", () => {
  it("runs PKCE over a loopback redirect and exchanges the code as the desktop client", async () => {
    let authorize: URL | null = null;
    const fetchImpl = tokenFetch();
    const base = options({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const credential = await signInToRomeCloud({
      ...base,
      openBrowser: async (raw) => {
        authorize = new URL(raw);
        await base.openBrowser(raw);
      },
    });

    expect(credential).toEqual({ accessToken: "romemob_token", deviceSessionId: "s1" });
    const sent = authorize as unknown as URL;
    expect(sent.origin + sent.pathname).toBe(`${CLOUD}/oauth2/authorize`);
    expect(sent.searchParams.get("client_id")).toBe(DESKTOP_CLIENT_ID);
    expect(sent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(sent.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CLOUD}/oauth2/token`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("client_id")).toBe(DESKTOP_CLIENT_ID);
    expect(form.get("code")).toBe("one-time");
    expect(form.get("platform")).toBe("macos");
    expect(form.get("redirect_uri")).toBe(sent.searchParams.get("redirect_uri"));
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("rejects a callback whose state does not match", async () => {
    await expect(
      signInToRomeCloud(
        options({
          openBrowser: async (raw) => {
            const url = new URL(raw);
            const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
            callback.searchParams.set("code", "one-time");
            callback.searchParams.set("state", "forged");
            callback.searchParams.set("iss", CLOUD);
            void fetch(callback);
          },
        }),
      ),
    ).rejects.toThrow(/state/);
  });

  it("aborts and refuses a token exchange cancelled after the browser answered", async () => {
    const abort = new AbortController();
    let exchangeSignal: AbortSignal | undefined;
    const fetchImpl = rs.fn(async (_url: string, init?: RequestInit) => {
      exchangeSignal = init?.signal ?? undefined;
      abort.abort();
      return Response.json({
        access_token: "romemob_token",
        token_type: "Bearer",
        device_session_id: "s1",
      });
    });
    await expect(
      signInToRomeCloud(
        options({ signal: abort.signal, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ),
    ).rejects.toThrow(/cancelled/);
    expect(exchangeSignal?.aborted).toBe(true);
  });

  it("stops waiting when cancelled", async () => {
    const abort = new AbortController();
    const pending = signInToRomeCloud(
      options({ signal: abort.signal, openBrowser: async () => abort.abort() }),
    );
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});

describe("computerPlatform", () => {
  it("names the platform the way Rome Cloud expects", () => {
    expect(computerPlatform("darwin")).toBe("macos");
    expect(computerPlatform("win32")).toBe("windows");
    expect(computerPlatform("linux")).toBe("linux");
  });
});
