import { describe, expect, it, rs } from "@rstest/core";
import { devicePlatform, deviceSessionFromToken } from "./device-session.js";

const mocks = rs.hoisted(() => ({ platform: rs.fn() }));
rs.mock("node:os", () => ({ platform: mocks.platform }));

const origin = "https://cloud.example";
const token = {
  access_token: `romedev_${"a".repeat(43)}`,
  token_type: "Bearer",
  device_id: "test-device",
};

describe("shared device session contract", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
    ["linux", "linux"],
  ])("maps %s to the Cloud platform %s", (local, cloud) => {
    mocks.platform.mockReturnValue(local);
    expect(devicePlatform()).toBe(cloud);
  });

  it("returns only the credential fields stored by both authorization flows", () => {
    expect(
      deviceSessionFromToken({ ...token, device_session_id: "session", extra: "ignored" }, origin),
    ).toEqual({
      cloudUrl: origin,
      token: token.access_token,
      deviceId: token.device_id,
    });
  });

  it.each([
    null,
    [],
    {},
    { ...token, access_token: "invalid" },
    { ...token, access_token: 123 },
    { ...token, device_id: "bad\nid" },
    { ...token, device_id: "" },
    { ...token, device_id: 123 },
    { ...token, token_type: "Basic" },
    { ...token, token_type: undefined },
  ])("rejects a malformed Cloud token response: %j", (body) => {
    expect(deviceSessionFromToken(body, origin)).toBeNull();
  });
});
