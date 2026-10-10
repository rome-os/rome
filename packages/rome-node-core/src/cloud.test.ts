import { afterEach, expect, it, rs } from "@rstest/core";
import { CloudError, gatewayConfig } from "./cloud.js";

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
