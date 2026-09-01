// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import CallbackPage from "./CallbackPage";

// The /callback screen tries setup resume first (`POST /api/setups/return`,
// correlated by state)
// and falls back to the legacy `/oauth/redeem` — the sign-in mechanic that keeps
// that route shared. What it SHOWS on failure is also a contract: a broker that
// attaches a readable error_description gets relayed verbatim, while a bare RFC
// 6749 code (older broker, deploy skew) is translated instead of leaking
// "invalid_grant" as the only explanation.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderCallback(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/callback${search}`]}>
      <CallbackPage />
    </MemoryRouter>,
  );
}

/** Surfaces wherever the callback navigated to, so a test can assert the
 *  landing path the guardian actually ends up on. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="landed-on">{`${location.pathname}${location.search}`}</div>;
}

/** Render the callback inside a router that reports the post-navigation path. */
function renderCallbackAndTrackLanding(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/callback${search}`]}>
      <Routes>
        <Route path="/callback" element={<CallbackPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Route the fetch mock by URL so the three calls (setup return, legacy redeem,
 *  identity probe) can be stubbed independently. */
function stubFetch(handlers: {
  setupReturn?: () => Response;
  redeem?: () => Response;
  identity?: () => Response;
}) {
  return rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/setups/return")) {
      return (
        handlers.setupReturn?.() ??
        new Response(JSON.stringify({ matched: false }), { status: 404 })
      );
    }
    if (url.includes("/api/oauth/redeem")) {
      return handlers.redeem?.() ?? new Response("{}", { status: 200 });
    }
    if (url.includes("/api/auth/me")) {
      // Default to a guardian. The probe only decides where a MATCHED setup
      // lands, and every test written before it existed assumed the dashboard's
      // own browser — an unspecified shape here would silently take that branch
      // for the wrong reason.
      return (
        handlers.identity?.() ?? new Response(JSON.stringify({ kind: "guardian" }), { status: 200 })
      );
    }
    return new Response("{}", { status: 200 });
  });
}

function stubRedeemFailure(error: string) {
  // The realistic sign-in scenario: the setup-return is a DEFINITIVE no-match
  // (404) — no setup owns this state — so the callback falls back to the legacy
  // redeem, which surfaces the broker error. (A 5xx on the return leg would be
  // ambiguous and route to integrations instead; see the routing suite.)
  return stubFetch({
    setupReturn: () => new Response(JSON.stringify({ matched: false }), { status: 404 }),
    redeem: () =>
      new Response(JSON.stringify({ error }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
  });
}

describe("CallbackPage error display", () => {
  it("translates a bare invalid_grant from the redeem response", async () => {
    stubRedeemFailure("invalid_grant");
    renderCallback("?handoff=h-bare-code&state=s-bare-code");

    expect(await screen.findByText(/Rome Cloud rejected this sign-in link/i)).toBeTruthy();
    expect(screen.queryByText("invalid_grant")).toBeNull();
  });

  it("shows the broker's readable error_description verbatim", async () => {
    stubRedeemFailure(
      "This sign-in link expired before Rome could redeem it. Please try connecting again.",
    );
    renderCallback("?handoff=h-described&state=s-described");

    expect(await screen.findByText(/expired before Rome could redeem it/i)).toBeTruthy();
  });

  it("translates a bare invalid_grant arriving as a provider error param", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    renderCallback("?error=invalid_grant");

    expect(await screen.findByText(/Rome Cloud rejected this sign-in link/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("CallbackPage return-leg routing", () => {
  it("delivers the return leg to a suspended setup and does NOT hit the legacy redeem", async () => {
    const fetchMock = stubFetch({
      setupReturn: () =>
        new Response(
          JSON.stringify({
            matched: true,
            cid: "setup-1",
            accepted: true,
            state: { status: "presenting", view: { progress: true } },
          }),
          { status: 200 },
        ),
    });
    renderCallback("?handoff=h-setup&state=s-setup-live");

    await rs.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/setups/return"))).toBe(
        true,
      ),
    );
    // A matched setup consumes the leg; the sign-in fallback is never reached.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/oauth/redeem"))).toBe(
      false,
    );
  });

  it("returns the guardian to the connected service's own page, not the retired Integrations tab", async () => {
    stubFetch({
      setupReturn: () =>
        new Response(
          JSON.stringify({
            matched: true,
            cid: "setup-gh",
            service: "github",
            accepted: true,
            state: { status: "presenting", view: { progress: true } },
          }),
          { status: 200 },
        ),
    });
    renderCallbackAndTrackLanding("?handoff=h-gh&state=s-gh-live");

    // The connection detail page is the only surface that re-attaches to the
    // still-redeeming setup and settles it to connected.
    const landed = await screen.findByTestId("landed-on");
    expect(landed.textContent).toBe("/settings/connections/github");
  });

  it("lands on the connections list when the matched setup names no service", async () => {
    stubFetch({
      setupReturn: () =>
        new Response(
          JSON.stringify({
            matched: true,
            cid: "setup-anon",
            accepted: true,
            state: { status: "presenting", view: { progress: true } },
          }),
          { status: 200 },
        ),
    });
    renderCallbackAndTrackLanding("?handoff=h-anon&state=s-anon-live");

    const landed = await screen.findByTestId("landed-on");
    expect(landed.textContent).toBe("/settings/connections");
  });

  it("falls back to the legacy redeem when no setup awaits the state (definitive 404)", async () => {
    const fetchMock = stubFetch({
      setupReturn: () => new Response(JSON.stringify({ matched: false }), { status: 404 }),
      redeem: () => new Response(JSON.stringify({ nextPath: "/" }), { status: 200 }),
    });
    renderCallback("?handoff=h-signin&state=s-signin");

    await rs.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/oauth/redeem"))).toBe(
        true,
      ),
    );
  });

  it("does not redeem a late return owned by a cancelled setup", async () => {
    const fetchMock = stubFetch({
      setupReturn: () =>
        new Response(
          JSON.stringify({
            matched: true,
            cid: "setup-cancelled",
            service: "github",
            accepted: false,
            state: { status: "cancelled" },
          }),
          { status: 409 },
        ),
    });
    renderCallback("?handoff=h-cancelled&state=s-cancelled");

    expect(await screen.findByText("Connection cancelled")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/oauth/redeem"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/me"))).toBe(false);
  });

  it("does NOT dead-end on redeem when the return leg fails ambiguously (5xx)", async () => {
    const fetchMock = stubFetch({
      setupReturn: () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      redeem: () => new Response(JSON.stringify({ nextPath: "/" }), { status: 200 }),
    });
    renderCallback("?handoff=h-amb&state=s-amb");

    await rs.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/setups/return"))).toBe(
        true,
      ),
    );
    // Ambiguous → the setup may have connected server-side; route to integrations
    // rather than failing on the already-consumed handoff.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/oauth/redeem"))).toBe(
      false,
    );
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("shows a failed setup's reason without falling back to redeem", async () => {
    const fetchMock = stubFetch({
      setupReturn: () =>
        new Response(
          JSON.stringify({
            matched: true,
            cid: "setup-2",
            accepted: true,
            state: { status: "failed", reason: "Authorization was declined." },
          }),
          { status: 200 },
        ),
    });
    renderCallback("?error=access_denied&state=s-denied");

    expect(await screen.findByText(/Authorization was declined/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/oauth/redeem"))).toBe(
      false,
    );
  });
});

// Where a MATCHED setup's return leg lands depends on whether the browser
// holding it has a dashboard session. The desktop shell hands provider sign-in
// to the SYSTEM browser, which has none: navigating there would put an
// AuthGate-protected route in front of a browser that can only answer it with
// /login — at the end of every successful connect.
describe("CallbackPage identity routing", () => {
  const matchedGithubSetup = () =>
    new Response(
      JSON.stringify({
        matched: true,
        cid: "setup-gh",
        service: "github",
        accepted: true,
        state: { status: "presenting", view: { progress: true } },
      }),
      { status: 200 },
    );

  const identity = (kind: string) => () => new Response(JSON.stringify({ kind }), { status: 200 });

  it("ends on the page when the browser has no session, claiming only delivery", async () => {
    stubFetch({ setupReturn: matchedGithubSetup, identity: identity("anonymous") });
    renderCallbackAndTrackLanding("?handoff=h-ext&state=s-ext");

    // A matched setup is typically still `presenting` while it redeems, and the
    // redeem or the conferral can still fail — so this page must not claim the
    // connection exists. It cannot wait for `done` either: `/api/setups/:cid`
    // stays private, so an anonymous browser has nothing to poll.
    expect(await screen.findByText("Authorization received")).toBeTruthy();
    expect(screen.queryByText(/Connected/)).toBeNull();
    // Nowhere to send it — the page has to be the ending.
    expect(screen.queryByTestId("landed-on")).toBeNull();
  });

  it("still returns a guardian to the connection's own page", async () => {
    stubFetch({ setupReturn: matchedGithubSetup, identity: identity("guardian") });
    renderCallbackAndTrackLanding("?handoff=h-guard&state=s-guard");

    const landed = await screen.findByTestId("landed-on");
    expect(landed.textContent).toBe("/settings/connections/github");
  });

  it("treats a visitor as a dashboard session too", async () => {
    // The check reads `!== "anonymous"` rather than enumerating the kinds that
    // count: a visitor is as much a browser session as a guardian, and an
    // enumeration would strand them on the terminal page.
    stubFetch({ setupReturn: matchedGithubSetup, identity: identity("visitor") });
    renderCallbackAndTrackLanding("?handoff=h-vis&state=s-vis");

    const landed = await screen.findByTestId("landed-on");
    expect(landed.textContent).toBe("/settings/connections/github");
  });

  const failedGithubSetup = () =>
    new Response(
      JSON.stringify({
        matched: true,
        cid: "setup-gh",
        service: "github",
        accepted: true,
        state: { status: "failed", reason: "Authorization was declined." },
      }),
      { status: 200 },
    );

  it("tells a sessionless browser the CONNECTION failed, with no login link", async () => {
    stubFetch({ setupReturn: failedGithubSetup, identity: identity("anonymous") });
    renderCallbackAndTrackLanding("?handoff=h-denied&state=s-denied-ext");

    // The generic error view offers "Return to login" — the wrong instruction
    // for someone who was connecting an account, in a browser that has no
    // session to return to.
    expect(await screen.findByText("Connection failed")).toBeTruthy();
    expect(screen.getByText(/Authorization was declined/i)).toBeTruthy();
    expect(screen.queryByText("Return to login")).toBeNull();
    expect(screen.queryByTestId("landed-on")).toBeNull();
  });

  it("keeps the existing error view for a browser that does have a session", async () => {
    stubFetch({ setupReturn: failedGithubSetup, identity: identity("guardian") });
    renderCallbackAndTrackLanding("?handoff=h-denied&state=s-denied-web");

    expect(await screen.findByText(/Authorization was declined/i)).toBeTruthy();
    expect(screen.getByText("Return to login")).toBeTruthy();
    expect(screen.queryByText("Connection failed")).toBeNull();
  });

  it("never probes identity on the sign-in leg", async () => {
    // Sign-in runs BEFORE its own cookie exists, so the probe would answer
    // "anonymous" for someone who is about to be signed in. It is also why this
    // check is a bare fetch rather than the auth gate's query: seeding that
    // cache here would bounce a successful sign-in straight back to /login.
    const fetchMock = stubFetch({
      setupReturn: () => new Response(JSON.stringify({ matched: false }), { status: 404 }),
      redeem: () => new Response(JSON.stringify({ nextPath: "/dashboard" }), { status: 200 }),
    });
    renderCallbackAndTrackLanding("?handoff=h-signin&state=s-signin-identity");

    const landed = await screen.findByTestId("landed-on");
    expect(landed.textContent).toBe("/dashboard");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/me"))).toBe(false);
  });
});
