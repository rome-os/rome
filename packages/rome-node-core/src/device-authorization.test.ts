import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { platform } from "node:os";
import { loginDeviceCode } from "./device-authorization.js";

const origin = "https://cloud.example";
const authorization = {
  device_code: "private-device-code",
  user_code: "ABCD-1234",
  verification_uri: `${origin}/device`,
  verification_uri_complete: `${origin}/device?user_code=ABCD-1234`,
  expires_in: 600,
  interval: 5,
};
const token = {
  access_token: `romedev_${"a".repeat(43)}`,
  token_type: "Bearer",
  device_id: "test-device",
  device_session_id: "test-session",
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  rs.useFakeTimers();
});
afterEach(() => {
  rs.restoreAllMocks();
  rs.useRealTimers();
});

function start(overrides = {}) {
  const fetch = rs
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(json({ ...authorization, ...overrides }));
  const controller = new AbortController();
  const prompt = rs.fn();
  const running = loginDeviceCode(origin, "Remote Linux", controller.signal, prompt);
  return { fetch, controller, prompt, running };
}

describe("device-code authorization", () => {
  it("posts forms, waits before polling, and returns the existing device session", async () => {
    const f = start({ interval: 3 });
    f.fetch.mockResolvedValueOnce(json(token));
    await rs.advanceTimersByTimeAsync(0);
    expect(f.prompt).toHaveBeenCalledWith({
      verificationUri: authorization.verification_uri,
      verificationUriComplete: authorization.verification_uri_complete,
      userCode: authorization.user_code,
      expiresIn: 600,
    });
    const issuance = f.fetch.mock.calls[0];
    expect(String(issuance[0])).toBe(`${origin}/oauth2/device_authorization`);
    expect(issuance[1]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(Object.fromEntries(issuance[1]!.body as URLSearchParams)).toEqual({
      client_id: "rome-computer",
      display_name: "Remote Linux",
      platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
    });
    await rs.advanceTimersByTimeAsync(2999);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await rs.advanceTimersByTimeAsync(1);
    expect(await f.running).toEqual({
      cloudUrl: origin,
      token: token.access_token,
      deviceId: token.device_id,
    });
    expect(String(f.fetch.mock.calls[1][0])).toBe(`${origin}/oauth2/token`);
    expect(Object.fromEntries(f.fetch.mock.calls[1][1]!.body as URLSearchParams)).toEqual({
      client_id: "rome-computer",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: authorization.device_code,
    });
    expect(rs.getTimerCount()).toBe(0);
  });

  it("keeps cumulative five-second backoff across pending responses", async () => {
    const f = start();
    for (const error of ["slow_down", "authorization_pending", "slow_down"])
      f.fetch.mockResolvedValueOnce(json({ error }, 400));
    f.fetch.mockResolvedValueOnce(json(token));
    for (const [wait, calls] of [
      [5000, 2],
      [10000, 3],
      [10000, 4],
      [15000, 5],
    ]) {
      await rs.advanceTimersByTimeAsync(wait - 1);
      expect(f.fetch).toHaveBeenCalledTimes(calls - 1);
      await rs.advanceTimersByTimeAsync(1);
      expect(f.fetch).toHaveBeenCalledTimes(calls);
    }
    await f.running;
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
    ["invalid_grant", "invalid"],
    ["private-device-code", "rejected"],
  ])("stops on %s without exposing the server response", async (error, message) => {
    const f = start();
    f.fetch.mockResolvedValue(json({ error, error_description: token.access_token }, 400));
    const rejected = expect(f.running).rejects.toThrow(message);
    await rs.advanceTimersByTimeAsync(5000);
    await rejected;
    await rs.advanceTimersByTimeAsync(600_000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(rs.getTimerCount()).toBe(0);
  });

  it("expires locally before the next poll", async () => {
    const f = start({ expires_in: 2 });
    const rejected = expect(f.running).rejects.toThrow("expired");
    await rs.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(rs.getTimerCount()).toBe(0);
  });

  it("cancels a polling delay without making another request", async () => {
    const f = start();
    const rejected = expect(f.running).rejects.toThrow("canceled");
    await rs.advanceTimersByTimeAsync(0);
    f.controller.abort();
    await rejected;
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(rs.getTimerCount()).toBe(0);
  });

  it.each(["issuance", "poll", "expiry"])("aborts an in-flight request on %s", async (stage) => {
    const fetch = rs.spyOn(globalThis, "fetch");
    if (stage !== "issuance")
      fetch.mockResolvedValueOnce(json({ ...authorization, expires_in: 6 }));
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          requestSignal = options!.signal!;
          requestSignal.addEventListener("abort", () => reject(requestSignal!.reason), {
            once: true,
          });
        }),
    );
    const running = loginDeviceCode(origin, "Test", controller.signal, rs.fn());
    const rejected = expect(running).rejects.toThrow(stage === "expiry" ? "expired" : "canceled");
    await rs.advanceTimersByTimeAsync(stage === "issuance" ? 0 : 5000);
    if (stage === "expiry") await rs.advanceTimersByTimeAsync(1000);
    else controller.abort();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(rs.getTimerCount()).toBe(0);
  });

  it("makes no request when already canceled", async () => {
    const fetch = rs.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    await expect(loginDeviceCode(origin, "Test", controller.signal, rs.fn())).rejects.toThrow(
      "canceled",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { expires_in: 0 },
    { expires_in: 3_000_000 },
    { interval: -1 },
    { interval: 0.5 },
    { user_code: "bad\ncode" },
    { device_code: "" },
    { verification_uri: "javascript:alert(1)" },
    { verification_uri_complete: "https://other.example/device" },
  ])("rejects invalid authorization metadata: %j", async (overrides) => {
    const f = start(overrides);
    await expect(f.running).rejects.toThrow("Invalid device authorization response");
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed tokens and does not expose transport errors", async () => {
    const f = start();
    f.fetch.mockResolvedValueOnce(json({ ...token, access_token: "secret-invalid-token" }));
    const rejected = expect(f.running).rejects.toThrow("Invalid token response");
    await rs.advanceTimersByTimeAsync(5000);
    await rejected;
    f.fetch.mockRejectedValueOnce(new Error(authorization.device_code));
    await expect(loginDeviceCode(origin, "Test", f.controller.signal, rs.fn())).rejects.toThrow(
      "Could not complete device authorization. Try connecting again.",
    );
  });
});
