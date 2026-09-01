import { describe, expect, it, rs } from "@rstest/core";
import { runDiscordCli } from "./index.js";

function broker(body: unknown, status = 200): typeof fetch {
  return rs.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

async function run(argv: string[], fetchImpl: typeof fetch) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runDiscordCli(argv, {
    fetch: fetchImpl,
    readFile: async () => "{}",
    readStdin: async () => "{}",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    internalApiPort: "5151",
    now: () => 100,
  });
  return { exitCode, stdout, stderr };
}

describe("discord CLI output contract", () => {
  it("projects a live auth identity into the stable JSON contract", async () => {
    const fetchImpl = broker({
      version: 1,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: "123", username: "rome-bot", global_name: null, avatar: null },
    });
    const result = await run(["auth", "--json"], fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      authenticated: true,
      source: "rome_connection",
      apiVersion: "10",
      bot: { id: "123", username: "rome-bot", globalName: null, avatar: null },
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:5151/_internal/discord/auth", {
      method: "GET",
    });
  });

  it("prints the documented auth status in text mode", async () => {
    const result = await run(
      ["auth"],
      broker({
        version: 1,
        status: 200,
        headers: {},
        body: { id: "123", username: "rome-bot", global_name: null, avatar: null },
      }),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout:
        "discord.com\n  ✓ Authenticated through Rome as @rome-bot\n  - Bot ID: 123\n  - API version: v10\n",
    });
  });

  it("uses exit 4 for a missing current grant", async () => {
    const result = await run(
      ["auth", "status", "--json"],
      broker(
        {
          version: 1,
          error: {
            type: "not_authenticated",
            message:
              "Discord is not connected through Rome. Connect it in Settings -> Connections.",
          },
        },
        401,
      ),
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      authenticated: false,
      error: { type: "not_authenticated" },
    });
  });

  it("distinguishes an in-progress pairing from a missing connection", async () => {
    const envelope = {
      version: 1,
      error: {
        type: "not_paired",
        message:
          "Discord connection setup is in progress, but your account is not paired yet. Finish pairing in Settings -> Connections.",
      },
    };
    const json = await run(["auth", "status", "--json"], broker(envelope, 409));
    expect(json.exitCode).toBe(4);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      authenticated: false,
      error: envelope.error,
    });

    const text = await run(["auth", "status"], broker(envelope, 409));
    expect(text.exitCode).toBe(4);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe(`${envelope.error.message}\n`);
  });

  it("emits one JSON object for API success and preserves 204 null bodies", async () => {
    const result = await run(
      ["api", "channels/123/messages", "--json", "--include"],
      broker({
        version: 1,
        status: 204,
        headers: { "x-ratelimit-remaining": "4" },
        body: null,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      status: 204,
      headers: { "x-ratelimit-remaining": "4" },
      body: null,
    });
  });

  it("sorts included text headers before the response body", async () => {
    const result = await run(
      ["api", "users/@me", "--include"],
      broker({
        version: 1,
        status: 200,
        headers: { "x-ratelimit-remaining": "4", "content-type": "application/json" },
        body: { id: "1" },
      }),
    );
    expect(result.stdout).toBe(
      'HTTP 200\ncontent-type: application/json\nx-ratelimit-remaining: 4\n\n{"id":"1"}\n',
    );
  });

  it("preserves Discord API error details and a non-zero exit", async () => {
    const result = await run(
      ["api", "channels/123", "--json"],
      broker({
        version: 1,
        status: 403,
        headers: {},
        body: { message: "Missing Permissions", code: 50013 },
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      status: 403,
      error: {
        type: "discord_api",
        code: 50013,
        message: "Missing Permissions",
        details: { message: "Missing Permissions", code: 50013 },
      },
    });
  });

  it("distinguishes Core unavailability from Discord network failures", async () => {
    const unavailable = rs.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const local = await run(["api", "users/@me", "--json"], unavailable);
    expect(JSON.parse(local.stdout).error.type).toBe("core_unavailable");

    const upstream = await run(
      ["api", "users/@me", "--json"],
      broker(
        {
          version: 1,
          error: {
            type: "network",
            message: "Discord request failed before a response was received.",
          },
        },
        502,
      ),
    );
    expect(JSON.parse(upstream.stdout).error.type).toBe("network");
  });

  it("keeps usage errors machine-readable when --json is present", async () => {
    const fetchImpl = broker({});
    const result = await run(["api", "users/@me", "--json", "--silent"], fetchImpl);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { type: "usage", message: "--json cannot be combined with --silent" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps verbose diagnostics off JSON stdout", async () => {
    const result = await run(
      ["api", "users/@me", "--json", "--verbose"],
      broker({ version: 1, status: 200, headers: {}, body: { id: "1" } }),
    );
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toContain("> GET /users/@me");
    expect(result.stderr).not.toContain("Authorization");
  });
});
