import { describe, expect, it } from "@rstest/core";
import { API_HELP, DiscordCliUsageError, parseDiscordArgs } from "./args.js";

describe("discord CLI argument parsing", () => {
  it.each([
    { argv: [] },
    { argv: ["help"] },
    { argv: ["-h"] },
    { argv: ["--help"] },
  ])("renders top-level help for $argv", ({ argv }) => {
    expect(parseDiscordArgs(argv).kind).toBe("help");
  });

  it.each([
    { argv: ["help", "api"] },
    { argv: ["api", "--help"] },
    { argv: ["api", "-h"] },
  ])("renders the normative API help for $argv", ({ argv }) => {
    expect(parseDiscordArgs(argv)).toEqual({ kind: "help", text: API_HELP });
  });

  it("parses API flags independently of endpoint position", () => {
    expect(
      parseDiscordArgs([
        "api",
        "-X",
        "patch",
        "channels/123",
        "-F",
        "name=agents",
        "-H",
        "X-Audit-Log-Reason:Rome",
        "--json",
      ]),
    ).toMatchObject({
      kind: "api",
      endpoint: "channels/123",
      method: "patch",
      fields: [{ kind: "field", value: "name=agents" }],
      headers: ["X-Audit-Log-Reason:Rome"],
      json: true,
    });
  });

  it("rejects conflicting and unknown arguments", () => {
    expect(() => parseDiscordArgs(["api", "users/@me", "--json", "--silent"])).toThrow(
      "--json cannot be combined with --silent",
    );
    expect(() => parseDiscordArgs(["wat"])).toThrow(DiscordCliUsageError);
    expect(() => parseDiscordArgs(["auth", "token"])).toThrow("not supported");
  });
});
