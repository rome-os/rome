import { expect, it } from "@rstest/core";
import { ImFixtureServer } from "./server.js";

it("fails closed on unknown routes and outbound origins instead of silently succeeding", async () => {
  const server = await new ImFixtureServer(() => undefined).start();
  try {
    await expect(server.fetch("https://example.invalid/messages")).rejects.toThrow(
      "blocked external origin",
    );
    expect((await server.fetch(`${server.url}/unknown`)).status).toBe(500);
    expect(() => server.assertClean()).toThrow("Unmodeled fixture request: GET /unknown");
    expect(server.calls).toHaveLength(1);
  } finally {
    await server.close();
  }
});

it("reports unused fault scripts and cancels request waiters when closed", async () => {
  const server = await new ImFixtureServer(() => ({ body: {} })).start();
  server.once({ method: "POST", path: "/unused", response: { status: 429 } });
  expect(() => server.assertClean()).toThrow("not consumed");
  const waiting = expect(server.waitForCall(() => false)).rejects.toThrow("Fixture closed");
  await server.close();
  await waiting;
});
