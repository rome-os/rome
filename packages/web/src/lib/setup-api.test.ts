// Node-env logic tests for the setup client fetchers. Fetch is
// stubbed; we pin the request shapes (routes, method, body) and the non-throwing
// result mapping (start error, 404 poll, 409 late input).

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  cancelSetup,
  getSetupState,
  isTerminalSetup,
  startSetup,
  submitSetupInput,
  type SetupState,
} from "@/lib/setup-api";

afterEach(() => rs.restoreAllMocks());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return rs
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(typeof input === "string" ? input : input.toString(), init)),
    );
}

describe("startSetup", () => {
  it("POSTs to the per-grant setup route and returns the start payload", async () => {
    const body = {
      cid: "c1",
      state: { status: "awaiting-input", form: { fields: [] } },
      reattached: false,
    };
    const fetchMock = stubFetch(() => new Response(JSON.stringify(body), { status: 200 }));
    const result = await startSetup("discord", "bot", { force: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/connections/discord/grants/bot/setup",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ force: true }) }),
    );
    expect(result).toEqual({ ok: true, start: body });
  });

  it("returns a non-throwing error when the route 404s", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "No conferral setup for this grant." }), {
          status: 404,
        }),
    );
    const result = await startSetup("discord", "nope");
    expect(result).toEqual({ ok: false, error: "No conferral setup for this grant." });
  });
});

describe("getSetupState", () => {
  it("returns the polled state", async () => {
    const state: SetupState = { status: "presenting", view: { title: "Working" } };
    stubFetch(() => new Response(JSON.stringify({ state }), { status: 200 }));
    expect(await getSetupState("c1")).toEqual(state);
  });

  it("returns null for an unknown setup", async () => {
    stubFetch(() => new Response("{}", { status: 404 }));
    expect(await getSetupState("gone")).toBeNull();
  });
});

describe("submitSetupInput", () => {
  it("POSTs answers and returns the outcome", async () => {
    const outcome = { accepted: true, state: { status: "done", conferral: {} } };
    const fetchMock = stubFetch(() => new Response(JSON.stringify(outcome), { status: 200 }));
    const result = await submitSetupInput("c1", { token: "abc" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setups/c1/input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ answers: { token: "abc" } }),
      }),
    );
    expect(result).toEqual({ ok: true, outcome });
  });

  it("surfaces a 409 late delivery as ok:true with accepted:false (caller re-polls)", async () => {
    const outcome = {
      accepted: false,
      reason: "Not awaiting input.",
      state: { status: "done", conferral: {} },
    };
    stubFetch(() => new Response(JSON.stringify(outcome), { status: 409 }));
    const result = await submitSetupInput("c1", {});
    expect(result).toEqual({ ok: true, outcome });
  });

  it("treats a 404 as a hard error (setup gone)", async () => {
    stubFetch(() => new Response("{}", { status: 404 }));
    const result = await submitSetupInput("gone", {});
    expect(result.ok).toBe(false);
  });
});

describe("cancelSetup", () => {
  it("POSTs cancel and returns the terminal state", async () => {
    const fetchMock = stubFetch(
      () => new Response(JSON.stringify({ state: { status: "cancelled" } }), { status: 200 }),
    );
    expect(await cancelSetup("c1")).toEqual({ status: "cancelled" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setups/c1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("isTerminalSetup", () => {
  it.each([
    [{ status: "done", conferral: {} }, true],
    [{ status: "failed", reason: "x" }, true],
    [{ status: "cancelled" }, true],
    [{ status: "awaiting-input", form: { fields: [] } }, false],
    [{ status: "presenting", view: {} }, false],
  ] as Array<[SetupState, boolean]>)("%o → %s", (state, expected) => {
    expect(isTerminalSetup(state)).toBe(expected);
  });
});
