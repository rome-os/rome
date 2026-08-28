import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  Client,
  REST,
  RESTEvents,
  type APIRequest,
  type InternalRequest,
  type RateLimitData,
  type ResponseLike,
} from "discord.js";
import type { ChannelApiRequest } from "./api-request.js";
import { DiscordAdapter } from "./discord.js";

const BASE_REQUEST: ChannelApiRequest = {
  method: "GET",
  path: "/users/@me",
  query: [],
  headers: {},
  body: null,
  timeoutMs: 30_000,
};

afterEach(() => {
  rs.useRealTimers();
  rs.restoreAllMocks();
});

describe("DiscordAdapter REST broker capability", () => {
  it("pins requests to Discord API v10 and keeps authentication provider-owned", async () => {
    const queue = rs.spyOn(REST.prototype, "queueRequest");
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    await expect(
      adapter.executeApiRequest({ ...BASE_REQUEST, path: "https://evil.example/users/@me" }),
    ).rejects.toThrow("absolute and protocol-relative endpoints are not accepted");
    await expect(
      adapter.executeApiRequest({
        ...BASE_REQUEST,
        headers: { Authorization: "Bot caller-owned" },
      }),
    ).rejects.toThrow("owned by the channel provider");
    expect(queue).not.toHaveBeenCalled();
  });

  it("shares one epoch-owned REST manager and projects safe response data", async () => {
    const managers = new Set<REST>();
    const queue = rs.spyOn(REST.prototype, "queueRequest").mockImplementation(async function (
      this: REST,
    ) {
      managers.add(this);
      return new Response(JSON.stringify({ id: "1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "secret",
          "x-ratelimit-remaining": "4",
        },
      }) as unknown as ResponseLike;
    });
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    await expect(adapter.executeApiRequest(BASE_REQUEST)).resolves.toEqual({
      response: {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4",
        },
        body: { id: "1" },
      },
    });
    await adapter.executeApiRequest({ ...BASE_REQUEST, path: "/guilds/2" });

    expect(queue).toHaveBeenCalledTimes(2);
    expect(managers.size).toBe(1);
    expect(JSON.stringify(queue.mock.calls)).not.toContain("not-exposed");
  });

  it("returns the current 401 outcome before reporting a credential fault", async () => {
    const onGatewayFault = rs.fn();
    rs.spyOn(REST.prototype, "queueRequest").mockImplementation(async function (
      this: REST,
      request: InternalRequest,
    ) {
      const response = new Response(JSON.stringify({ message: "401: Unauthorized", code: 0 }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as unknown as ResponseLike;
      await this.emit(
        RESTEvents.Response,
        {
          method: request.method,
          path: request.fullRoute,
          route: request.fullRoute,
          options: {},
          data: { signal: request.signal },
          retries: 0,
        } as APIRequest,
        response,
      );
      throw new Error("discord.js projected 401");
    });
    const adapter = new DiscordAdapter({ botToken: "not-exposed", onGatewayFault });

    await expect(adapter.executeApiRequest(BASE_REQUEST)).resolves.toMatchObject({
      response: {
        status: 401,
        body: { message: "401: Unauthorized", code: 0 },
      },
    });
    expect(onGatewayFault).toHaveBeenCalledWith({
      kind: "credential",
      cause: expect.any(Error),
    });
  });

  it("returns a rate-limit failure instead of an intermediate 429 at the deadline", async () => {
    rs.useFakeTimers();
    rs.spyOn(REST.prototype, "queueRequest").mockImplementation(async function (
      this: REST,
      request: InternalRequest,
    ) {
      await this.emit(
        RESTEvents.Response,
        {
          method: request.method,
          path: request.fullRoute,
          route: request.fullRoute,
          options: {},
          data: { signal: request.signal },
          retries: 0,
        } as APIRequest,
        new Response(JSON.stringify({ message: "You are being rate limited." }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        }) as unknown as ResponseLike,
      );
      await this.emit(RESTEvents.RateLimited, {
        global: false,
        method: "GET",
        url: "https://discord.com/api/v10/users/@me",
        route: "/users/@me",
        majorParameter: "global",
        hash: "/users/@me",
        limit: 1,
        timeToReset: 60_000,
        retryAfter: 60_000,
        sublimitTimeout: 0,
        scope: "user",
      } satisfies RateLimitData);
      return new Promise<ResponseLike>(() => undefined);
    });
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    const result = adapter.executeApiRequest({ ...BASE_REQUEST, timeoutMs: 1_000 });
    await rs.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({
      error: {
        type: "rate_limit",
        message: "Discord's rate-limit wait exceeded the request deadline.",
        retryAfterMs: 60_000,
      },
    });
  });

  it("aborts queued broker requests when the credential epoch stops", async () => {
    rs.spyOn(Client.prototype, "destroy").mockResolvedValue();
    let signal: AbortSignal | undefined;
    rs.spyOn(REST.prototype, "queueRequest").mockImplementation(
      async (_request: InternalRequest) => {
        signal = _request.signal;
        return new Promise<ResponseLike>(() => undefined);
      },
    );
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    const result = adapter.executeApiRequest(BASE_REQUEST);
    await adapter.stop();

    expect(signal?.aborted).toBe(true);
    await expect(result).resolves.toEqual({
      error: {
        type: "network",
        message: "Discord connection changed before the request completed.",
      },
    });
  });
});
