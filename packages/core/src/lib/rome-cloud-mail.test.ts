import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { setInstanceTokenInMemory } from "./instance-identity.js";
import { MailProviderError, RomeCloudMailProvider } from "./rome-cloud-mail.js";

function providerAnswering(body: unknown) {
  const fetch = rs.fn(async () => Response.json(body));
  return {
    fetch,
    provider: new RomeCloudMailProvider({ fetch: fetch as unknown as typeof globalThis.fetch }),
  };
}

describe("RomeCloudMailProvider.send", () => {
  beforeEach(() => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://rome-cloud.test");
    setInstanceTokenInMemory("romeinst_test-token");
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    setInstanceTokenInMemory(null);
  });

  it("returns the message and thread IDs Rome Cloud accepted", async () => {
    const { fetch, provider } = providerAnswering({ messageId: "m1", threadId: "t1" });

    await expect(provider.send({ to: "a@example.com", text: "hi" })).resolves.toEqual({
      messageId: "m1",
      threadId: "t1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports an accepted send without both IDs as unconfirmed, not as unsent", async () => {
    for (const body of [
      {},
      { messageId: "m1" },
      { messageId: "m1", threadId: "  " },
      { threadId: "t1" },
      { messageId: 7, threadId: "t1" },
    ]) {
      const { provider } = providerAnswering(body);
      const result = provider.send({ to: "a@example.com", text: "hi" });

      await expect(result).rejects.toBeInstanceOf(MailProviderError);
      await expect(result).rejects.toThrow("Check email history before retrying");
    }
  });
});
