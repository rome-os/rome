import { describe, expect, it, rs } from "@rstest/core";
import { registerDevice } from "./device-registration.js";

const P = "https://romeos.cc";

describe("registerDevice", () => {
  it("POSTs an APNs token + environment to Rome Cloud with the CSRF header", async () => {
    const fetchImpl = rs.fn(async () => new Response("{}", { status: 201 }));
    const result = await registerDevice(fetchImpl as unknown as typeof fetch, {
      provider: "apns",
      platform: "ios",
      romeCloudOrigin: P,
      token: "tok-a",
      apnsEnvironment: "sandbox",
    });
    expect(result).toEqual({ ok: true, status: 201 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://romeos.cc/api/devices");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-rome-device-client"]).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "apns",
      token: "tok-a",
      platform: "ios",
      apns_environment: "sandbox",
    });
  });

  it("POSTs an FCM token with no apns_environment (Android)", async () => {
    const fetchImpl = rs.fn(async () => new Response("{}", { status: 201 }));
    const result = await registerDevice(fetchImpl as unknown as typeof fetch, {
      provider: "fcm",
      platform: "android",
      romeCloudOrigin: P,
      token: "fcm-tok",
    });
    expect(result).toEqual({ ok: true, status: 201 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "fcm",
      token: "fcm-tok",
      platform: "android",
    });
  });

  it("reports status without throwing on HTTP failure", async () => {
    const fetchImpl = rs.fn(async () => new Response("no", { status: 401 }));
    await expect(
      registerDevice(fetchImpl as unknown as typeof fetch, {
        provider: "apns",
        platform: "ios",
        romeCloudOrigin: P,
        token: "t",
        apnsEnvironment: "sandbox",
      }),
    ).resolves.toEqual({ ok: false, status: 401 });
  });

  it("reports status 0 without throwing on network error", async () => {
    const fetchImpl = rs.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      registerDevice(fetchImpl as unknown as typeof fetch, {
        provider: "fcm",
        platform: "android",
        romeCloudOrigin: P,
        token: "t",
      }),
    ).resolves.toEqual({ ok: false, status: 0 });
  });
});
