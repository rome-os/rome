import { describe, expect, it, rs } from "@rstest/core";
import type { registerDevice } from "./device-registration.js";
import { NOTIFICATION_CHANNEL_ID, runPushRegistration } from "./push-registration.js";

const P = "https://romeos.cc";

// A fake expo-notifications with all-granted / token-yielding defaults; override
// per test. `calls` records the invocation order across the three primitives.
function makeNotifications(
  calls: string[] = [],
  over: Partial<Record<"granted" | "token", unknown>> = {},
) {
  return {
    setNotificationChannelAsync: rs.fn(async () => {
      calls.push("channel");
      return {};
    }),
    requestPermissionsAsync: rs.fn(async () => {
      calls.push("permission");
      return { granted: (over.granted ?? true) as boolean };
    }),
    getDevicePushTokenAsync: rs.fn(async () => {
      calls.push("token");
      return { data: (over.token ?? "tok") as string };
    }),
    AndroidImportance: { HIGH: 4 },
  };
}

const okRegister = () => rs.fn(async () => ({ ok: true, status: 201 }));
const asRegister = (m: unknown) => m as unknown as typeof registerDevice;
const base = {
  fetchImpl: fetch,
  romeCloudOrigin: P,
  getApnsEnvironment: rs.fn(() => "sandbox" as const),
  delay: rs.fn(async () => {}),
};

describe("runPushRegistration — iOS", () => {
  it("skips the channel, registers APNs with the environment, returns true", async () => {
    const notifications = makeNotifications();
    const register = okRegister();
    const getApnsEnvironment = rs.fn(() => "sandbox" as const);

    const ok = await runPushRegistration({
      ...base,
      platform: "ios",
      notifications,
      register: asRegister(register),
      getApnsEnvironment,
    });

    expect(ok).toBe("registered");
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(fetch, {
      provider: "apns",
      platform: "ios",
      romeCloudOrigin: P,
      token: "tok",
      apnsEnvironment: "sandbox",
    });
    expect(getApnsEnvironment).toHaveBeenCalledTimes(1);
  });
});

describe("runPushRegistration — Android", () => {
  it("creates the HIGH channel BEFORE permission, registers FCM, never reads the APNs env", async () => {
    const calls: string[] = [];
    const notifications = makeNotifications(calls);
    const register = rs.fn(async () => {
      calls.push("register");
      return { ok: true, status: 201 };
    });
    const getApnsEnvironment = rs.fn(() => "sandbox" as const);

    const ok = await runPushRegistration({
      ...base,
      platform: "android",
      notifications,
      register: asRegister(register),
      getApnsEnvironment,
    });

    expect(ok).toBe("registered");
    // Order matters on Android 13+: channel must exist before the prompt.
    expect(calls).toEqual(["channel", "permission", "token", "register"]);
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      NOTIFICATION_CHANNEL_ID,
      {
        name: "Rome",
        importance: 4,
      },
    );
    expect(register).toHaveBeenCalledWith(fetch, {
      provider: "fcm",
      platform: "android",
      romeCloudOrigin: P,
      token: "tok",
    });
    // APNs env is meaningless on Android and must never be validated there.
    expect(getApnsEnvironment).not.toHaveBeenCalled();
  });
});

describe("runPushRegistration — short-circuits", () => {
  it("returns permission-denied and does not fetch a token or register when denied", async () => {
    const notifications = makeNotifications([], { granted: false });
    const register = okRegister();
    const ok = await runPushRegistration({
      ...base,
      platform: "android",
      notifications,
      register: asRegister(register),
    });
    // Distinct from a retryable failure: the caller must NOT re-prompt this session.
    expect(ok).toBe("permission-denied");
    expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("returns not-registered (retryable) and does not register when no token is returned", async () => {
    const notifications = makeNotifications([], { token: "" });
    const register = okRegister();
    const ok = await runPushRegistration({
      ...base,
      platform: "ios",
      notifications,
      register: asRegister(register),
    });
    expect(ok).toBe("not-registered");
    expect(register).not.toHaveBeenCalled();
  });

  it("propagates a getDevicePushTokenAsync throw (e.g. Expo Go / FCM not init) and does not register", async () => {
    // getDevicePushTokenAsync throws in Expo Go and when FCM isn't initialized.
    // runPushRegistration doesn't catch — the caller's try/catch
    // degrades it to "push registration skipped". It must not register.
    const notifications = {
      ...makeNotifications(),
      getDevicePushTokenAsync: rs.fn(async (): Promise<{ data: string }> => {
        throw new Error("getDevicePushTokenAsync is not available in Expo Go");
      }),
    };
    const register = okRegister();
    await expect(
      runPushRegistration({
        ...base,
        platform: "android",
        notifications,
        register: asRegister(register),
      }),
    ).rejects.toThrow(/Expo Go/);
    // Got past channel + permission before the throw; never reached register.
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("runPushRegistration — 401 retry", () => {
  it("retries once after a delay on 401 and succeeds", async () => {
    const notifications = makeNotifications();
    const register = rs
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 201 });
    const delay = rs.fn(async () => {});
    const ok = await runPushRegistration({
      ...base,
      platform: "ios",
      notifications,
      register: asRegister(register),
      delay,
    });
    expect(ok).toBe("registered");
    expect(register).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(3000);
  });

  it("returns not-registered if the single retry also fails", async () => {
    const notifications = makeNotifications();
    const register = rs.fn(async () => ({ ok: false, status: 401 }));
    const delay = rs.fn(async () => {});
    const ok = await runPushRegistration({
      ...base,
      platform: "ios",
      notifications,
      register: asRegister(register),
      delay,
    });
    expect(ok).toBe("not-registered");
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a non-401 failure", async () => {
    const notifications = makeNotifications();
    const register = rs.fn(async () => ({ ok: false, status: 400 }));
    const delay = rs.fn(async () => {});
    const ok = await runPushRegistration({
      ...base,
      platform: "ios",
      notifications,
      register: asRegister(register),
      delay,
    });
    expect(ok).toBe("not-registered");
    expect(register).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
