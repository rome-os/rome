import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { postSessionTurn } from "./chat-api";

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("postSessionTurn", () => {
  it("preserves structured model resolution errors from the server", async () => {
    rs.stubGlobal(
      "fetch",
      rs.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Selected model provider is unavailable: Codex",
            code: "model_provider_unavailable",
            provider: "openai",
            reason: "not_logged_in",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(postSessionTurn("session-1", new FormData())).resolves.toEqual({
      ok: false,
      status: 409,
      message: "Selected model provider is unavailable: Codex",
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });
});
