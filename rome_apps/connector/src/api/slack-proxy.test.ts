import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { readSlackOAuthTokens, selectSlackToken, type SlackOAuthTokens } from "./slack-proxy.js";

const tokens: SlackOAuthTokens = { botToken: "xoxb-bot", userToken: "xoxp-user", teamId: "T1" };

describe("selectSlackToken", () => {
  it("uses the bot token for ordinary methods", () => {
    expect(selectSlackToken("https://slack.com/api/chat.postMessage", tokens)).toBe("xoxb-bot");
    expect(selectSlackToken("https://slack.com/api/conversations.list", tokens)).toBe("xoxb-bot");
  });

  it("uses the user token for search.* methods", () => {
    expect(selectSlackToken("https://slack.com/api/search.messages", tokens)).toBe("xoxp-user");
  });

  it("throws a clear error when search is requested but no user token is present", () => {
    const botOnly: SlackOAuthTokens = { botToken: "xoxb-bot", userToken: null, teamId: "T1" };
    expect(() => selectSlackToken("https://slack.com/api/search.messages", botOnly)).toThrow(
      /user token/i,
    );
  });
});

describe("readSlackOAuthTokens", () => {
  let tempDir: string;
  let file: string;
  const saved = process.env.ROME_SLACK_TOKEN_FILE;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rome-slack-proxy-"));
    file = join(tempDir, "slack-oauth-token");
    process.env.ROME_SLACK_TOKEN_FILE = file;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ROME_SLACK_TOKEN_FILE;
    else process.env.ROME_SLACK_TOKEN_FILE = saved;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when the token file does not exist (not connected)", async () => {
    expect(await readSlackOAuthTokens()).toBeNull();
  });

  it("parses the bot token, user token, and team id", async () => {
    writeFileSync(file, JSON.stringify({ botToken: "xoxb-b", userToken: "xoxp-u", teamId: "T9" }));
    expect(await readSlackOAuthTokens()).toEqual({
      botToken: "xoxb-b",
      userToken: "xoxp-u",
      teamId: "T9",
    });
  });

  it("returns null on malformed JSON or a missing bot token", async () => {
    writeFileSync(file, "not json");
    expect(await readSlackOAuthTokens()).toBeNull();
    writeFileSync(file, JSON.stringify({ userToken: "xoxp-u" }));
    expect(await readSlackOAuthTokens()).toBeNull();
  });
});
