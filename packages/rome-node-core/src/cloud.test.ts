import { afterEach, expect, it, rs } from "@rstest/core";
import { CloudError, cloudRequest, gatewayConfig } from "./cloud.js";

afterEach(() => {
  rs.restoreAllMocks();
});

it.each([
  "wss://gateway.test/connect",
  "ws://localhost:8080/connect",
  "ws://127.0.0.1:8080/connect",
  "ws://[::1]:8080/connect",
])("accepts the Cloud-provided Gateway URL %s", async (gatewayUrl) => {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ gatewayUrl }));
  expect(await gatewayConfig("https://cloud.test", "token")).toBe(gatewayUrl);
});

it.each([
  "ws://gateway.test/connect",
  "ws://192.168.1.10/connect",
  "ws://localhost.example/connect",
  "ws://user:secret@127.0.0.1/connect",
  "ws://127.0.0.1/connect?token=secret",
  "ws://[::1]/connect#secret",
  "not a URL",
])("rejects the Cloud-provided Gateway URL %s", async (gatewayUrl) => {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ gatewayUrl }));
  await expect(gatewayConfig("https://cloud.test", "token")).rejects.toEqual(
    new CloudError("invalid_response"),
  );
});

it("sends a JSON body with its content type", async () => {
  const fetch = rs
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  expect(
    await cloudRequest("https://cloud.test", "/api/account/devices/x", "token", "PATCH", {
      name: "Mac",
    }),
  ).toBeNull();
  const init = fetch.mock.calls[0][1];
  expect(init?.method).toBe("PATCH");
  expect(init?.body).toBe('{"name":"Mac"}');
  expect(init?.headers).toMatchObject({
    Authorization: "Bearer token",
    "content-type": "application/json",
  });
});

it.each([
  [404, "device_not_found", "device_not_found"],
  [400, "invalid_device_name", "invalid_device_name"],
  [503, "revocation_pending", "revocation_pending"],
  [404, "something_else", "cloud_unavailable"],
  [500, undefined, "cloud_unavailable"],
])("maps a %i %s answer to %s", async (status, error, code) => {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error }, { status }));
  await expect(cloudRequest("https://cloud.test", "/path", "token", "DELETE")).rejects.toEqual(
    new CloudError(code),
  );
});
