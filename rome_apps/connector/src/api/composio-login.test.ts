import { describe, expect, it } from "@rstest/core";
import { CliLoginError, parseApiKeyFromSession, parseLoginSession } from "./composio-login.js";

// Fixtures captured from `composio` CLI v0.2.27 in the dev runtime container.
const REAL_LOGIN_STDOUT = `{
  "status": "pending",
  "message": "Complete login by opening the URL",
  "login_url": "https://dashboard.composio.dev/?cliKey=00000000-0000-4000-8000-000000000000",
  "cli_key": "00000000-0000-4000-8000-000000000000",
  "expires_at": "2026-05-29T04:34:13.587Z"
}`;

// Fixture captured from `composio` CLI v0.2.32 (the version pinned in the
// Dockerfile), which replaced the JSON contract with human-readable text.
const REAL_LOGIN_STDOUT_TEXT = `Open this URL in your browser to log in:

  https://dashboard.composio.dev/?cliKey=59aea532-0e11-47ba-bc1c-62e7ab242117

Then run this command to complete login:

  composio login --poll

hint: For agents: Show the URL above to the user to click, then run the command above.`;

describe("parseLoginSession", () => {
  it("extracts the login URL and session key from real CLI output", () => {
    const session = parseLoginSession(REAL_LOGIN_STDOUT);
    expect(session.loginUrl).toBe(
      "https://dashboard.composio.dev/?cliKey=00000000-0000-4000-8000-000000000000",
    );
    expect(session.cliKey).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("tolerates a stray banner line leaking onto stdout before the JSON", () => {
    const withBanner = `Update available: 0.2.27 -> 0.2.28\n${REAL_LOGIN_STDOUT}`;
    const session = parseLoginSession(withBanner);
    expect(session.cliKey).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("parses the v0.2.32 human-readable text output (URL carries the cliKey)", () => {
    const session = parseLoginSession(REAL_LOGIN_STDOUT_TEXT);
    expect(session.loginUrl).toBe(
      "https://dashboard.composio.dev/?cliKey=59aea532-0e11-47ba-bc1c-62e7ab242117",
    );
    expect(session.cliKey).toBe("59aea532-0e11-47ba-bc1c-62e7ab242117");
  });

  it("tolerates ANSI escapes around the text-format login URL", () => {
    const withAnsi = `\x1B[1mOpen this URL:\x1B[22m https://dashboard.composio.dev/?cliKey=59aea532-0e11-47ba-bc1c-62e7ab242117\n`;
    const session = parseLoginSession(withAnsi);
    expect(session.cliKey).toBe("59aea532-0e11-47ba-bc1c-62e7ab242117");
  });

  it("fails loudly when the output is empty", () => {
    expect(() => parseLoginSession("")).toThrowError(CliLoginError);
    try {
      parseLoginSession("");
    } catch (err) {
      expect((err as CliLoginError).code).toBe("parse_failed");
    }
  });

  it("fails loudly when login_url/cli_key are missing", () => {
    expect(() => parseLoginSession(`{"status":"pending"}`)).toThrowError(/missing login_url/);
  });
});

describe("parseApiKeyFromSession", () => {
  it("returns the issued api_key from a logged-in session file", () => {
    const raw = `{"api_key":"comp_live_abc123","base_url":"https://backend.composio.dev","org_id":null}`;
    expect(parseApiKeyFromSession(raw)).toBe("comp_live_abc123");
  });

  it("rejects the pre-login session where api_key is null", () => {
    // This is the exact shape the CLI writes before a successful login.
    const raw = `{"api_key":null,"base_url":"https://backend.composio.dev","web_url":"https://dashboard.composio.dev/","org_id":null,"test_user_id":null}`;
    try {
      parseApiKeyFromSession(raw);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliLoginError);
      expect((err as CliLoginError).code).toBe("no_key");
    }
  });

  it("rejects a malformed session file", () => {
    try {
      parseApiKeyFromSession("not json");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CliLoginError).code).toBe("no_key");
    }
  });
});
