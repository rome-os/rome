import { describe, expect, it } from "@rstest/core";
import { legacyBotToken, revokeLegacyBotToken } from "./legacy-token.js";

const signal = new AbortController().signal;

function slackAnswering(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("revoking a token a grant from before the Worker holds", () => {
  it("finds the token only in such a grant", () => {
    expect(legacyBotToken({ botToken: "xoxb-1" })).toBe("xoxb-1");
    expect(legacyBotToken({ teamId: "T", depositKey: "k" })).toBeNull();
  });

  it("revokes it once at Slack with the token as bearer", async () => {
    const slack = slackAnswering(200, { ok: true, revoked: true });
    expect(await revokeLegacyBotToken("xoxb-1", signal, slack.fetchImpl)).toBeNull();
    expect(slack.calls).toEqual([
      { url: "https://slack.com/api/auth.revoke", auth: "Bearer xoxb-1" },
    ]);
  });

  it("counts a token Slack already refuses as revoked", async () => {
    const slack = slackAnswering(200, { ok: false, error: "token_revoked" });
    expect(await revokeLegacyBotToken("xoxb-1", signal, slack.fetchImpl)).toBeNull();
  });

  it("says why Slack did not revoke it, without the token", async () => {
    const refused = await revokeLegacyBotToken(
      "xoxb-1",
      signal,
      slackAnswering(429, { ok: false, error: "ratelimited" }).fetchImpl,
    );
    expect(refused).toBe("ratelimited");
    const down = await revokeLegacyBotToken("xoxb-1", signal, (async () => {
      throw new TypeError("fetch failed xoxb-1");
    }) as unknown as typeof fetch);
    expect(down).toBe("TypeError");
  });
});
