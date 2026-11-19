import { afterEach, expect, it, rs } from "@rstest/core";
import { CloudError, cloudRequest, gatewayConfig } from "./cloud.js";
import { parseGatewayUrl } from "./gateway-url.js";

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

it("resolves a Gateway path on the connection origin, including its port", async () => {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ gatewayPath: "/ws/container-node" }),
  );
  expect(await gatewayConfig("https://rome.example:9443", "token")).toBe(
    "wss://rome.example:9443/ws/container-node",
  );
});

it("allows a private HTTP address only for a direct container Gateway on that address", async () => {
  const origin = "http://192.168.1.10:3000";
  const fetch = rs
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ gatewayPath: "/ws/container-node" }));
  await expect(gatewayConfig(origin, "token")).rejects.toEqual(new CloudError("cloud_unavailable"));
  expect(fetch).not.toHaveBeenCalled();
  const gateway = await gatewayConfig(origin, "token", true);
  expect(gateway).toBe("ws://192.168.1.10:3000/ws/container-node");
  expect(parseGatewayUrl(gateway, origin).href).toBe(gateway);
  expect(() => parseGatewayUrl("ws://192.168.1.20:3000/ws/container-node", origin)).toThrow();
  fetch.mockResolvedValueOnce(
    Response.json({ gatewayUrl: "ws://192.168.1.10:3000/ws/container-node" }),
  );
  await expect(gatewayConfig(origin, "token", true)).rejects.toEqual(
    new CloudError("invalid_response"),
  );
  await expect(gatewayConfig("http://rome.example", "token", true)).rejects.toEqual(
    new CloudError("cloud_unavailable"),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  "//other.example/connect",
  "/\\other.example/connect",
  "wss://other.example/connect",
])("rejects a non-local Gateway path %s", async (gatewayPath) => {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ gatewayPath }));
  await expect(gatewayConfig("https://rome.example", "token")).rejects.toEqual(
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
