import { describe, expect, it } from "@rstest/core";
import { readApiResponse, requiresComposioSignIn } from "./api.js";

describe("connector API errors", () => {
  it.each(["composio_unauthenticated", "no_api_key"])("requires sign-in for %s", async (code) => {
    const response = Response.json({ error: code, message: "Sign in again" }, { status: 401 });
    const error = await readApiResponse(response, "Request failed").catch((err: unknown) => err);

    expect(requiresComposioSignIn(error)).toBe(true);
    expect(error).toMatchObject({ message: "Sign in again" });
  });

  it.each([
    403, 429, 502,
  ])("keeps HTTP %i failures separate from credential rejection", async (status) => {
    const response = Response.json(
      { error: "webhook_registration_failed", message: "Try again" },
      { status },
    );
    const error = await readApiResponse(response, "Request failed").catch((err: unknown) => err);

    expect(requiresComposioSignIn(error)).toBe(false);
    expect(error).toMatchObject({ message: "Try again" });
  });

  it("does not confuse the host's 401 or a non-JSON gateway error with Composio rejection", async () => {
    const error = await readApiResponse(
      new Response("Unauthorized", { status: 401 }),
      "Request failed",
    ).catch((err: unknown) => err);

    expect(requiresComposioSignIn(error)).toBe(false);
    expect(error).toMatchObject({ message: "Request failed" });
  });
});
