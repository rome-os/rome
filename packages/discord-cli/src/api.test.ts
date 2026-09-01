import { describe, expect, it, rs } from "@rstest/core";
import { buildDiscordApiRequest } from "./api.js";
import { parseDiscordArgs, type ParsedApiCommand } from "./args.js";

const deps = {
  readFile: rs.fn(async (path: string) => (path === "payload.json" ? '{"embeds":[]}' : "42")),
  readStdin: rs.fn(async () => "false"),
};

function command(args: string[]): ParsedApiCommand {
  return parseDiscordArgs(["api", ...args]) as ParsedApiCommand;
}

describe("discord api request construction", () => {
  it("infers POST and decodes typed fields into a JSON body", async () => {
    await expect(
      buildDiscordApiRequest(
        command([
          "channels/123/messages?wait=true",
          "-F",
          "limit=20",
          "-F",
          'allowed_mentions={"parse":[]}',
          "-f",
          "content=false",
        ]),
        deps,
      ),
    ).resolves.toMatchObject({
      method: "POST",
      endpoint: "/channels/123/messages",
      query: [["wait", "true"]],
      body: { limit: 20, allowed_mentions: { parse: [] }, content: "false" },
    });
  });

  it("preserves repeated GET query fields and input order", async () => {
    const request = await buildDiscordApiRequest(
      command(["channels/123/messages?before=9", "-X", "GET", "-F", "tag=1", "-F", "tag=2"]),
      deps,
    );
    expect(request.query).toEqual([
      ["before", "9"],
      ["tag", "1"],
      ["tag", "2"],
    ]);
    expect(request.body).toBeNull();
  });

  it("reads complete JSON input and rejects protected headers", async () => {
    await expect(
      buildDiscordApiRequest(command(["channels/123/messages", "--input", "payload.json"]), deps),
    ).resolves.toMatchObject({ method: "POST", body: { embeds: [] } });
    await expect(
      buildDiscordApiRequest(command(["users/@me", "-H", "authorization:nope"]), deps),
    ).rejects.toThrow("owned by Rome Core");
  });

  it("allows only one stdin consumer and rejects duplicate body keys", async () => {
    await expect(
      buildDiscordApiRequest(command(["users/@me", "-F", "a=@-", "-F", "b=@-"]), deps),
    ).rejects.toThrow("only one option");
    await expect(
      buildDiscordApiRequest(command(["users/@me", "-F", "a=1", "-f", "a=2"]), deps),
    ).rejects.toThrow("repeated");
  });
});
