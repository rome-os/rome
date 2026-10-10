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
    "network",
    "429",
    "503",
    "proxy-html",
    "body-disconnect",
  ])("backs off and recovers from %s without issuing another device code", async (failure) => {
    const f = start();
    if (failure === "network") f.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    else if (failure === "body-disconnect") {
      const response = json(token);
      rs.spyOn(response, "json").mockRejectedValueOnce(new TypeError("terminated"));
      f.fetch.mockResolvedValueOnce(response);
    } else if (failure === "proxy-html")
      f.fetch.mockResolvedValueOnce(new Response("<html>Unavailable</html>", { status: 502 }));
    else f.fetch.mockResolvedValueOnce(json({}, Number(failure)));
    f.fetch.mockResolvedValueOnce(json(token));
    await rs.advanceTimersByTimeAsync(5000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await rs.advanceTimersByTimeAsync(9999);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await rs.advanceTimersByTimeAsync(1);
    expect(await f.running).toEqual({
      cloudUrl: origin,
      token: token.access_token,
      deviceId: token.device_id,
    });
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(String(f.fetch.mock.calls[2][0])).toBe(`${origin}/oauth2/token`);
    expect((f.fetch.mock.calls[2][1]!.body as URLSearchParams).get("device_code")).toBe(
      authorization.device_code,
    );
    expect(rs.getTimerCount()).toBe(0);
  });

  it("retries the request timeout after reducing polling frequency", async () => {
    rs.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(10_000);
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds,
      );
      return controller.signal;
    });
    const f = start();
    let requestSignal: AbortSignal | undefined;
    f.fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          requestSignal = options!.signal!;
          requestSignal.addEventListener("abort", () => reject(requestSignal!.reason), {
            once: true,
          });
        }),
    );
    f.fetch.mockResolvedValueOnce(json(token));
    await rs.advanceTimersByTimeAsync(14_999);
    expect(requestSignal?.aborted).toBe(false);
    await rs.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    await rs.advanceTimersByTimeAsync(9999);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await rs.advanceTimersByTimeAsync(1);
    expect(await f.running).toMatchObject({ deviceId: token.device_id });
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });

  it("caps exponential backoff and preserves it across pending responses", async () => {
    const f = start();
    for (let i = 0; i < 5; i++) f.fetch.mockRejectedValueOnce(new TypeError("offline"));
    f.fetch.mockResolvedValueOnce(json({ error: "authorization_pending" }, 400));
    f.fetch.mockResolvedValueOnce(json(token));
    let calls = 1;
    for (const wait of [5000, 10000, 20000, 40000, 60000, 60000, 60000]) {
      await rs.advanceTimersByTimeAsync(wait - 1);
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      await rs.advanceTimersByTimeAsync(1);
      expect(f.fetch).toHaveBeenCalledTimes(++calls);
    }
    await f.running;
  });

  it("does not reduce a Cloud interval above the retry cap", async () => {
    const f = start({ interval: 60 });
    f.fetch.mockResolvedValueOnce(json({ error: "slow_down" }, 400));
    f.fetch.mockRejectedValueOnce(new TypeError("offline"));
    f.fetch.mockResolvedValueOnce(json(token));
    await rs.advanceTimersByTimeAsync(125_000);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    await rs.advanceTimersByTimeAsync(64_999);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    await rs.advanceTimersByTimeAsync(1);
    await f.running;
  });

  it.each(["canceled", "expired"])("stops retry backoff when %s", async (reason) => {
    const f = start({ expires_in: 12 });
    f.fetch.mockRejectedValue(new TypeError("offline"));
    const rejected = expect(f.running).rejects.toThrow(reason);
    await rs.advanceTimersByTimeAsync(5000);
    if (reason === "canceled") f.controller.abort();
    else await rs.advanceTimersByTimeAsync(7000);
    await rejected;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(rs.getTimerCount()).toBe(0);
  });

  it.each([200, 400, 401])("keeps malformed JSON terminal for HTTP %s", async (status) => {
    const f = start();
    f.fetch.mockResolvedValueOnce(new Response("secret-invalid-json", { status }));
    const rejected = expect(f.running).rejects.toThrow("Invalid device authorization response.");
    await rs.advanceTimersByTimeAsync(5000);
    await rejected;
    await rs.advanceTimersByTimeAsync(600_000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])("keeps HTTP %s terminal", async (status) => {
    const f = start();
    f.fetch.mockResolvedValueOnce(json({ error: "invalid_client" }, status));
    const rejected = expect(f.running).rejects.toThrow("rejected");
    await rs.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry device-code issuance after an HTTP failure", async () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({}, 503));
    const prompt = rs.fn();
    await expect(
      loginDeviceCode(origin, "Test", new AbortController().signal, prompt),
    ).rejects.toThrow("Could not complete device authorization");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
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
