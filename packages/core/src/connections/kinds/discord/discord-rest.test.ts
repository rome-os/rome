import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  ChannelManager,
  Client,
  REST,
  RESTEvents,
  type APIRequest,
  type InternalRequest,
  type RateLimitData,
  type ResponseLike,
} from "discord.js";
import type { ConnectionApiRequest } from "../../../apps/platform-requests.js";
import { DiscordAdapter } from "./discord.js";

const BASE_REQUEST: ConnectionApiRequest = {
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

  it("returns Discord's 404 payload through the default undici transport", async () => {
    // The default transport shares one body between the Response event and
    // the response discord.js reads before it throws.
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Unknown Message", code: 10008 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const adapter = new DiscordAdapter({
        botToken: "not-exposed",
        rest: { api: `http://127.0.0.1:${port}/api` },
      });

      await expect(
        adapter.executeApiRequest({ ...BASE_REQUEST, path: "/channels/1/messages/2" }),
      ).resolves.toMatchObject({
        response: {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { message: "Unknown Message", code: 10008 },
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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

  it("stops a history read, and sends it no further requests, when the credential epoch stops", async () => {
    rs.spyOn(Client.prototype, "destroy").mockResolvedValue();
    const routes: string[] = [];
    let signal: AbortSignal | undefined;
    rs.spyOn(REST.prototype, "queueRequest").mockImplementation(
      async (request: InternalRequest) => {
        routes.push(request.fullRoute);
        signal = request.signal;
        return new Promise<ResponseLike>(() => undefined);
      },
    );
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    const read = adapter.readHistory("100000000000000003" as never, { limit: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.stop();

    await expect(read).rejects.toThrow("Discord connection stopped during the read");
    expect(signal?.aborted).toBe(true);
    await expect(adapter.readHistory("100000000000000003" as never, { limit: 5 })).rejects.toThrow(
      "Discord connection has stopped",
    );
    expect(routes).toHaveLength(1);
  });

  describe("whether the bot may read a chat's history", () => {
    /** The adapter over a chat Discord answers through `fetched`, with the
     *  gateway's own view of it allowing the read. */
    function adapterOver(fetched: () => Promise<{ allows: boolean }>) {
      const adapter = new DiscordAdapter({ botToken: "not-exposed" });
      const client = (adapter as unknown as { client: { user: unknown } }).client;
      Object.defineProperty(client, "user", { value: { id: "1" }, configurable: true });
      // The gateway's cache says yes until Discord is asked.
      let allows = true;
      const guild = {
        roles: { fetch: rs.fn(async () => undefined) },
        members: { fetchMe: rs.fn(async () => undefined) },
      };
      const channel = {
        guild,
        isThread: () => false,
        permissionsFor: () => ({ has: () => allows }),
      };
      const fetch = rs.spyOn(ChannelManager.prototype, "fetch").mockImplementation((async (
        _id: string,
        options?: { force?: boolean },
      ) => {
        if (options?.force) allows = (await fetched()).allows;
        return channel;
      }) as never);
      const readsHistoryIn = (id: string) =>
        (
          adapter as unknown as { readsHistoryIn(id: string): Promise<boolean | null> }
        ).readsHistoryIn(id);
      return { readsHistoryIn, fetch, guild };
    }

    it("asks Discord, not the gateway's cache", async () => {
      const { readsHistoryIn, fetch, guild } = adapterOver(async () => ({ allows: false }));

      await expect(readsHistoryIn("3")).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledWith("3", { force: true });
      expect(guild.roles.fetch).toHaveBeenCalledWith(undefined, { force: true });
      expect(guild.members.fetchMe).toHaveBeenCalledWith({ force: true });
    });

    it("answers no where Discord refuses the chat, and cannot tell where it fails", async () => {
      const refused = adapterOver(async () => {
        throw Object.assign(new Error("Missing Access"), { status: 403 });
      });
      await expect(refused.readsHistoryIn("3")).resolves.toBe(false);
      rs.restoreAllMocks();

      const failing = adapterOver(async () => {
        throw Object.assign(new Error("Internal Server Error"), { status: 500 });
      });
      await expect(failing.readsHistoryIn("3")).resolves.toBeNull();
    });
  });
});
