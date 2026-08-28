import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelApiResult } from "../../channels/api-request.js";
import type { GrantState } from "../../connections/types.js";
import { CredentialRejected } from "../../connections/errors.js";
import type { ApiDeps } from "../deps.js";
import { discordCliRoutes } from "./discord-cli.js";

function appWith(
  execute?: (request: unknown) => Promise<ChannelApiResult>,
  opts: { activeSetup?: "placeholder" | "existing"; botGrantState?: GrantState } = {},
) {
  return discordCliRoutes(
    {
      setupManager: opts.activeSetup
        ? ({
            activeFor: (idOrService: string, grant: string) =>
              idOrService === (opts.activeSetup === "existing" ? "discord-1" : "discord") &&
              grant === "bot"
                ? "setup-1"
                : null,
          } as NonNullable<ApiDeps["setupManager"]>)
        : undefined,
      connectionRegistry:
        execute || opts.activeSetup === "existing" || opts.botGrantState
          ? ({
              find: (service: string) =>
                service === "discord"
                  ? [
                      {
                        id: "discord-1",
                        auth: {
                          grants: () => ({ bot: opts.botGrantState ?? "unauthorized" }),
                        },
                        act: execute
                          ? {
                              operations: () => [
                                {
                                  name: "discord.api.request",
                                  description: "Execute a Discord REST request",
                                  inputSchema: {},
                                },
                              ],
                              invoke: ({ input }: { input?: unknown }) => execute(input),
                            }
                          : null,
                      },
                    ]
                  : [],
            } as unknown as NonNullable<ApiDeps["connectionRegistry"]>)
          : undefined,
    },
    "127.0.0.1",
  );
}

describe("Discord CLI loopback broker routes", () => {
  it("fails route registration closed on a non-loopback listener", () => {
    expect(() => discordCliRoutes({}, "0.0.0.0")).toThrow("loopback");
  });

  it("reports a missing current Discord epoch without calling Discord", async () => {
    const response = await appWith().request("/_internal/discord/auth");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      version: 1,
      error: {
        type: "not_authenticated",
        message: "Discord is not connected through Rome. Connect it in Settings -> Connections.",
      },
    });
  });

  it.each([
    "placeholder",
    "existing",
  ] as const)("reports an in-progress %s Discord setup as not paired", async (activeSetup) => {
    const response = await appWith(undefined, { activeSetup }).request("/_internal/discord/auth");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      version: 1,
      error: {
        type: "not_paired",
        message:
          "Discord connection setup is in progress, but your account is not paired yet. Finish pairing in Settings -> Connections.",
      },
    });
  });

  it("keeps a degraded Discord bot grant distinguishable from missing auth", async () => {
    const response = await appWith(undefined, { botGrantState: "degraded" }).request(
      "/_internal/discord/auth",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      version: 1,
      error: {
        type: "credential_rejected",
        status: 401,
        message:
          "Discord rejected Rome's bot credential. Reconnect Discord in Settings -> Connections.",
      },
    });
  });

  it("reports a credential rejection from the current Discord Act", async () => {
    const response = await appWith(async () => {
      throw new CredentialRejected({ grant: "bot" });
    }).request("/_internal/discord/auth");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      version: 1,
      error: {
        type: "credential_rejected",
        status: 401,
        message:
          "Discord rejected Rome's bot credential. Reconnect Discord in Settings -> Connections.",
      },
    });
  });

  it("auth checks the live /users/@me identity", async () => {
    const execute = rs.fn(
      async (): Promise<ChannelApiResult> => ({
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { id: "1", username: "rome-bot" },
        },
      }),
    );
    const response = await appWith(execute).request("/_internal/discord/auth");
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({
      method: "GET",
      path: "/users/@me",
      query: [],
      headers: {},
      body: null,
      timeoutMs: 30_000,
    });
  });

  it("revalidates hand-crafted requests and protected headers", async () => {
    const execute = rs.fn();
    const response = await appWith(execute).request("/_internal/discord/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        method: "GET",
        endpoint: "https://evil.example/users/@me",
        query: [],
        headers: { Authorization: "Bot stolen" },
        body: null,
        timeoutMs: 30_000,
      }),
    });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized broker request before dispatch", async () => {
    const execute = rs.fn();
    const response = await appWith(execute).request("/_internal/discord/api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      version: 1,
      error: { type: "request_too_large" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns completed Discord errors over local HTTP 200 and strips unsafe headers", async () => {
    const execute = rs.fn(async () => ({
      response: {
        status: 403,
        headers: {
          "Set-Cookie": "secret",
          Authorization: "Bot secret",
          "X-RateLimit-Remaining": "4",
        },
        body: { message: "Missing Permissions", code: 50013 },
      },
    }));
    const response = await appWith(execute).request("/_internal/discord/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        method: "GET",
        endpoint: "channels/123/messages",
        query: [["limit", "20"]],
        headers: {},
        body: null,
        timeoutMs: 30_000,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      status: 403,
      headers: { "x-ratelimit-remaining": "4" },
      body: { message: "Missing Permissions", code: 50013 },
    });
    expect(execute).toHaveBeenCalledWith({
      method: "GET",
      path: "/channels/123/messages",
      query: [["limit", "20"]],
      headers: {},
      body: null,
      timeoutMs: 30_000,
    });
  });

  it("does not expose a serialized Discord response above 16 MiB", async () => {
    const response = await appWith(async () => ({
      response: {
        status: 200,
        headers: {},
        body: "x".repeat(16 * 1024 * 1024),
      },
    })).request("/_internal/discord/auth");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      version: 1,
      error: { type: "response_too_large" },
    });
  });
});
