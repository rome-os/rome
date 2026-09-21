// @rstest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setupServer } from "msw/node";
import { settingsHandlers } from "./settings";

const server = setupServer(...settingsHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("Pi settings mock handlers", () => {
  it("supports the redacted configuration lifecycle", async () => {
    const initial = await (await fetch("/api/ai-tools/pi")).json();
    expect(
      initial.providers.find((provider: { id: string }) => provider.id === "kimi-coding"),
    ).toMatchObject({ configured: false, credentialSource: "none" });

    const saved = await (
      await fetch("/api/ai-tools/pi/credential", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "kimi-coding", token: "never-retained" }),
      })
    ).json();
    expect(saved.credentialPersisted).toBe(true);
    expect(saved.status.providers).toContainEqual(
      expect.objectContaining({ id: "kimi-coding", configured: true }),
    );
    expect(JSON.stringify(saved)).not.toContain("never-retained");

    const refreshed = await (
      await fetch("/api/ai-tools/pi/refresh/kimi-coding", { method: "POST" })
    ).json();
    expect(refreshed.models).toContainEqual(
      expect.objectContaining({ providerId: "kimi-coding", modelId: "mock-model" }),
    );

    const removed = await (
      await fetch("/api/ai-tools/pi/credential/kimi-coding", { method: "DELETE" })
    ).json();
    expect(removed.status.providers).toContainEqual(
      expect.objectContaining({ id: "kimi-coding", configured: false, credentialSource: "none" }),
    );
  });
});
