import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { setInstanceTokenInMemory } from "./instance-identity.js";
import { fetchRomeCredits, RomeCreditsUnavailableError } from "./rome-credits.js";

const TOKEN = "romeinst_credits_test";
const balance = {
  enabled: true,
  grantedMicros: "10000000",
  balanceMicros: "7250000",
  reservedMicros: "500000",
  availableMicros: "6750000",
  models: ["gpt-5.6-terra"],
  requests: [],
};

function enroll() {
  rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
  setInstanceTokenInMemory(TOKEN);
}

function respond(status: number, body: unknown) {
  return rs.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  setInstanceTokenInMemory(null);
  rs.unstubAllEnvs();
});

describe("fetchRomeCredits", () => {
  it("reads the account balance from the gateway with the instance token", async () => {
    enroll();
    const fetchImpl = respond(200, balance);
    expect(await fetchRomeCredits(fetchImpl as unknown as typeof fetch)).toEqual({
      grantedMicros: "10000000",
      balanceMicros: "7250000",
      availableMicros: "6750000",
      enabled: true,
      models: ["gpt-5.6-terra"],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://cloud.example/v1/inference/usage");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads an empty served list as empty, not unknown", async () => {
    enroll();
    const disabled = { ...balance, enabled: false, models: [] };
    expect(await fetchRomeCredits(respond(200, disabled) as unknown as typeof fetch)).toMatchObject(
      { enabled: false, models: [] },
    );
  });

  it.each([
    ["missing", undefined],
    ["not an array", "gpt-5.6-terra"],
    ["not all strings", ["gpt-5.6-terra", 5]],
  ])("leaves the served models unknown when the list is %s", async (_label, models) => {
    enroll();
    const view = await fetchRomeCredits(
      respond(200, { ...balance, models }) as unknown as typeof fetch,
    );
    expect(view).toMatchObject({ grantedMicros: "10000000" });
    expect(view).not.toHaveProperty("models");
  });

  it("shows nothing for an instance not signed in to Rome Cloud", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    const fetchImpl = respond(200, balance);
    expect(await fetchRomeCredits(fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    401, 403,
  ])("shows nothing when Rome Cloud rejects the credential (%i)", async (status) => {
    enroll();
    expect(await fetchRomeCredits(respond(status, {}) as unknown as typeof fetch)).toBeNull();
  });

  it("shows nothing for an account that was never granted credits", async () => {
    enroll();
    const none = {
      ...balance,
      enabled: false,
      grantedMicros: "0",
      balanceMicros: "0",
      availableMicros: "0",
    };
    expect(await fetchRomeCredits(respond(200, none) as unknown as typeof fetch)).toBeNull();
  });

  it("keeps a used-up grant visible", async () => {
    enroll();
    const usedUp = { ...balance, balanceMicros: "0", availableMicros: "0" };
    expect(await fetchRomeCredits(respond(200, usedUp) as unknown as typeof fetch)).toMatchObject({
      grantedMicros: "10000000",
      balanceMicros: "0",
    });
  });

  it.each([
    ["a server error", respond(503, { error: "down" })],
    ["a malformed body", respond(200, { balanceMicros: 5 })],
    [
      "a network failure",
      rs.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ],
  ])("reports Rome Cloud as unavailable on %s", async (_label, fetchImpl) => {
    enroll();
    await expect(fetchRomeCredits(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      RomeCreditsUnavailableError,
    );
  });

  it.each([403, 503])("releases the unread body of a %i answer", async (status) => {
    enroll();
    const cancel = rs.fn();
    const body = new ReadableStream({ cancel });
    const fetchImpl = rs.fn(async () => new Response(body, { status }));
    await fetchRomeCredits(fetchImpl as unknown as typeof fetch).catch(() => {});
    expect(cancel).toHaveBeenCalled();
  });
});
