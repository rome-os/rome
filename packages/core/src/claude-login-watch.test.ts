import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  createClaudeLoginWatcher,
  stripAnsi,
  type ClaudeLoginEvent,
} from "./claude-login-watch.js";

function collect() {
  const events: ClaudeLoginEvent[] = [];
  const sends: string[] = [];
  const watcher = createClaudeLoginWatcher(
    (e) => events.push(e),
    (data) => sends.push(data),
  );
  activeWatchers.push(watcher);
  return { events, sends, watcher };
}

const activeWatchers: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const watcher of activeWatchers.splice(0)) {
    watcher.dispose();
  }
  rs.useRealTimers();
});

// The real shapes printed by the `claude /login` first-run wizard (an Ink TUI):
// words are positioned with cursor escapes instead of spaces — cursor-forward
// (CUF, `\x1b[1C`) and, on newer CLIs, also column-absolute (CHA, `\x1b[9G`) —
// and the sign-in URL is an OSC-8 hyperlink whose target holds the full URL
// (terminated by BEL) followed by wrapped, truncated visible text.
const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=Ng_Xgbq3jKUzRbyOpT" +
  "&code_challenge_method=S256&state=vE31j03G9o0jslKiUO1AupHcrqrJqBOA1GOk4M0a5vU";

// OSC-8 hyperlink: `ESC ] 8 ; id=… ; <full URL> BEL <visible truncated URL> ESC ] 8 ;; BEL`.
const URL_OUTPUT =
  `\x1b]8;id=h66nb8;${URL}\x07\x1b[38;2;153;153;153m${URL.slice(0, 78)}\x1b[39m\x1b]8;;\x07\r\n` +
  "\x1b[1CPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n";

const URL_OUTPUT_ST =
  `\x1b]8;id=h66nb8;${URL}\x1b\\\x1b[38;2;153;153;153m${URL.slice(0, 78)}\x1b[39m\x1b]8;;\x1b\\\r\n` +
  "\x1b[1CPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n";

// Some terminals do not receive an OSC-8 hyperlink target from `claude`; the
// TUI falls back to a plain URL wrapped across physical terminal rows.
const WRAPPED_URL_OUTPUT =
  "\x1b[1ABrowser didn't open?\x1b[1CUse the url\x1b[1Cbelow\x1b[1Cto\x1b[1Csign\x1b[1Cin\x1b[1C(c\x1b[1Cto\x1b[1Ccopy)\r\r\n" +
  "\r\r\n" +
  `${URL.slice(0, 88)}\r\r\n` +
  `${URL.slice(88, 166)}\r\r\n` +
  `${URL.slice(166, 244)}\r\r\n` +
  `${URL.slice(244)}\r\r\n` +
  "\r\r\n" +
  "\x1b[1CPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n";

const THEME_OUTPUT =
  "\x1b[1CLet's\x1b[1Cget\x1b[1Cstarted.\r\n" +
  "\x1b[1C\x1b[1mChoose\x1b[1Cthe\x1b[1Ctext\x1b[1Cstyle\x1b[1Cthat\x1b[1Clooks\x1b[1Cbest\x1b[1Cwith\x1b[1Cyour\x1b[1Cterminal\x1b[22m\r\n" +
  "\x1b[1C\x1b[38;2;177;185;249m❯\x1b[1C2.\x1b[1CDark\x1b[1Cmode\x1b[1C✔\x1b[39m\r\n";

const LOGIN_OUTPUT =
  "\x1b[1mClaude Code can be used with your Claude subscription or billed based on API \r\n" +
  "usage through your Console account.\x1b[22m\r\n" +
  "Select login method:\x1b[K\r\n" +
  "\x1b[38;2;177;185;249m❯\x1b[4CClaude account with subscription · \x1b[38;2;153;153;153mPro, Max, Team, or Enterprise\r\n";

// CLI 2.1.251 shapes, captured from a live `claude /login` PTY run. The theme
// screen positions words with CHA (`\x1b[9G`) and ends rendered lines with
// CR CR LF; the login screen keeps real spaces inside its phrases and joins
// lines with CR + CUF + CUD — the same stream mixes both escape families, so
// only the theme fixture exercises the CHA→space stripping.
const THEME_OUTPUT_CHA =
  "\x1b[2GLet's\x1b[8Gget\x1b[12Gstarted.\r\r\n" +
  "\x1b[2G\x1b[1mChoose\x1b[9Gthe\x1b[13Gtext\x1b[18Gstyle\x1b[24Gthat\x1b[29Glooks\x1b[35Gbest\x1b[40Gwith\x1b[45Gyour\x1b[50Gterminal\x1b[22m\r\r\n" +
  "\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4G\x1b[38;2;153;153;153m2.\x1b[7G\x1b[38;2;78;186;101mDark\x1b[12Gmode\x1b[17G✔\x1b[39m\r\r\n";

const LOGIN_OUTPUT_CHA =
  "\x1b[1mClaude Code can be used with your Claude subscription or billed based on API \r\x1b[1C\x1b[1B" +
  "usage through your Console account.\r\x1b[1C\x1b[1B\x1b[22m\x1b[K\r\x1b[1C\x1b[1B" +
  "Select login method:\x1b[K\r\x1b[1C\x1b[2B" +
  "\x1b[38;2;177;185;249m❯\x1b[7GClaude account with subscription · \x1b[38;2;153;153;153mPro, Max, Team, or Enterprise\r\r\n";

const NOT_LOGGED_IN_OUTPUT =
  "\x1b[2m╭─── Claude Code v2.1.251 ─────────────────────────────────────────────────────╮\r\n" +
  "\x1b[2m│\x1b[22m Opus 4.7 (1M context) · API Usage Billing                            \x1b[2m│\r\n" +
  "\x1b[2m╰──────────────────────────────────────────────────────────────────────────────╯\r\n" +
  "\x1b[1C?\x1b[1Cfor\x1b[1Cshortcuts\x1b[1CNot\x1b[1Clogged\x1b[1Cin\x1b[1C·\x1b[1CRun\x1b[1C/login\r\n";

// A rejected code, printed with CUF spacing like the rest of the TUI.
const ERROR_OUTPUT =
  "\x1b[1C\x1b[38;2;255;107;128mOAuth\x1b[1Cerror:\x1b[1CInvalid\x1b[1Ccode.\x1b[1CPlease\x1b[1Cmake\x1b[1Csure\x1b[1Cthe\x1b[1Cfull\x1b[1Ccode\x1b[1Cwas\x1b[1Ccopied\x1b[39m\r\n";

const REQUEST_FAILED_OUTPUT =
  "\x1b[1C\x1b[38;2;255;107;128mOAuth\x1b[1Cerror:\x1b[1CRequest\x1b[1Cfailed\x1b[1Cwith\x1b[1Cstatus\x1b[1Ccode\x1b[1C400\x1b[39m\r\n";

const UNPARSEABLE_POST_PICKER_OUTPUT =
  "https://claude.com/cai/oauth/authorize?client_id=missing-state\r\n" +
  "\x1b[1CPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n";

describe("stripAnsi", () => {
  it("turns cursor-forward escapes into spaces so glued words separate", () => {
    expect(stripAnsi("Choose\x1b[1Cthe\x1b[1Ctext\x1b[1Cstyle")).toBe("Choose the text style");
  });

  it("turns column-absolute escapes into spaces so glued words separate", () => {
    expect(stripAnsi("Choose\x1b[9Gthe\x1b[13Gtext\x1b[18Gstyle")).toBe("Choose the text style");
  });

  it("drops OSC-8 hyperlinks and CSI colour codes", () => {
    expect(stripAnsi(`\x1b[38;2;1;2;3mhi\x1b]8;id=x;${URL}\x07link\x1b]8;;\x07\x1b[39m`)).toBe(
      "hilink",
    );
  });
});

describe("createClaudeLoginWatcher", () => {
  it("emits the auth URL from the OSC-8 hyperlink target, unwrapped", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT);
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("does not auto-advance stale picker text once the auth URL is already present", () => {
    const { events, sends, watcher } = collect();
    watcher.push(LOGIN_OUTPUT + URL_OUTPUT);
    expect(events).toContainEqual({ type: "auth_url", url: URL });
    expect(sends).toEqual([]);
  });

  it("emits the auth URL from OSC-8 hyperlinks terminated by ST", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT_ST);
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("reassembles a plain URL wrapped across terminal rows", () => {
    const { events, watcher } = collect();
    watcher.push(WRAPPED_URL_OUTPUT);
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("recovers the URL when the OSC target is split across two PTY chunks", () => {
    const { events, watcher } = collect();
    const marker = `\x1b]8;id=h66nb8;${URL}\x07`;
    const split = marker.indexOf("authorize") + 4;
    watcher.push(marker.slice(0, split));
    expect(events).toEqual([]);
    watcher.push(marker.slice(split));
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("does not emit a truncated URL before its BEL terminator arrives", () => {
    const { events, watcher } = collect();
    watcher.push(`\x1b]8;id=h66nb8;${URL}`);
    expect(events).toEqual([]);
    watcher.push("\x07");
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("does not emit a truncated plain wrapped URL before its terminator arrives", () => {
    const { events, watcher } = collect();
    const partial = WRAPPED_URL_OUTPUT.slice(0, WRAPPED_URL_OUTPUT.indexOf(URL.slice(88, 166)));
    watcher.push(partial);
    expect(events).toEqual([]);
    watcher.push(WRAPPED_URL_OUTPUT.slice(partial.length));
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("does not mistake the wrapped, truncated visible URL for the real one", () => {
    const { events, watcher } = collect();
    // Only the truncated visible fragment (ends in ESC, not BEL) — no full URL.
    watcher.push(`\x1b[38;2;153;153;153m${URL.slice(0, 78)}\x1b[39m\r\n`);
    expect(events.filter((e) => e.type === "auth_url")).toHaveLength(0);
  });

  it("emits the URL at most once across many chunks", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT);
    watcher.push(URL_OUTPUT);
    expect(events.filter((e) => e.type === "auth_url")).toHaveLength(1);
  });

  it("also parses the plain `claude auth login` URL format (whitespace-terminated)", () => {
    const { events, watcher } = collect();
    watcher.push(`If the browser didn't open, visit: ${URL}\r\nPaste code here if prompted > `);
    expect(events).toContainEqual({ type: "auth_url", url: URL });
  });

  it("emits an auth_error with the CLI's wording when a code is rejected", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT);
    watcher.push(ERROR_OUTPUT);
    expect(events).toContainEqual({
      type: "auth_error",
      message: "Invalid code. Please make sure the full code was copied",
    });
  });

  it("emits an auth_error for generic OAuth request failures", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT);
    watcher.push(REQUEST_FAILED_OUTPUT);
    expect(events).toContainEqual({
      type: "auth_error",
      message: "Request failed with status code 400",
    });
  });

  it("emits a fresh auth_error for each retry, not just the first", () => {
    const { events, watcher } = collect();
    watcher.push(URL_OUTPUT);
    watcher.push(ERROR_OUTPUT);
    watcher.push(ERROR_OUTPUT);
    expect(events.filter((e) => e.type === "auth_error")).toHaveLength(2);
  });

  it("stays silent for output that is not a login flow (logout)", () => {
    const { events, sends, watcher } = collect();
    watcher.push("Logged out successfully.\r\n");
    expect(events).toEqual([]);
    expect(sends).toEqual([]);
  });

  describe("auto-advancing the first-run wizard", () => {
    it("presses Enter to accept the theme picker's default", () => {
      const { sends, watcher } = collect();
      watcher.push(THEME_OUTPUT);
      expect(sends).toEqual(["\r"]);
    });

    it("retries Enter when the theme picker remains visible and idle", () => {
      rs.useFakeTimers();
      const { sends, watcher } = collect();
      watcher.push(THEME_OUTPUT);
      expect(sends).toEqual(["\r"]);

      rs.advanceTimersByTime(1499);
      expect(sends).toEqual(["\r"]);

      rs.advanceTimersByTime(1);
      expect(sends).toEqual(["\r", "\r"]);
    });

    it("presses Enter when the theme screen shows Dark mode", () => {
      const { sends, watcher } = collect();
      watcher.push("\x1b[38;2;177;185;249m❯\x1b[1CDark\x1b[1Cmode\x1b[39m\r\n");
      expect(sends).toEqual(["\r"]);
    });

    it("presses Enter to select the Claude AI (subscription) login method", () => {
      const { sends, watcher } = collect();
      watcher.push(LOGIN_OUTPUT);
      expect(sends).toEqual(["\r"]);
    });

    it("retries Enter when the login picker remains visible and idle", () => {
      rs.useFakeTimers();
      const { sends, watcher } = collect();
      watcher.push(LOGIN_OUTPUT);
      expect(sends).toEqual(["\r"]);

      rs.advanceTimersByTime(1500);
      expect(sends).toEqual(["\r", "\r"]);
    });

    it("gives the login picker a fresh retry delay after advancing from theme", () => {
      rs.useFakeTimers();
      const { sends, watcher } = collect();
      watcher.push(THEME_OUTPUT);
      rs.advanceTimersByTime(1000);

      watcher.push(LOGIN_OUTPUT);
      expect(sends).toEqual(["\r", "\r"]);

      rs.advanceTimersByTime(499);
      expect(sends).toEqual(["\r", "\r"]);

      rs.advanceTimersByTime(1001);
      expect(sends).toEqual(["\r", "\r", "\r"]);
    });

    it("stops retrying once the auth URL arrives", () => {
      rs.useFakeTimers();
      const { sends, watcher } = collect();
      watcher.push(LOGIN_OUTPUT);
      expect(sends).toEqual(["\r"]);

      watcher.push(URL_OUTPUT);
      rs.advanceTimersByTime(1500);
      expect(sends).toEqual(["\r"]);
    });

    it("stops retrying when the code prompt arrives even if the auth URL is not parseable", () => {
      rs.useFakeTimers();
      const { events, sends, watcher } = collect();
      watcher.push(LOGIN_OUTPUT);
      expect(sends).toEqual(["\r"]);

      watcher.push(UNPARSEABLE_POST_PICKER_OUTPUT);
      expect(events.filter((e) => e.type === "auth_url")).toHaveLength(0);

      rs.advanceTimersByTime(1500);
      expect(sends).toEqual(["\r"]);
    });

    it("presses Enter when the login screen shows Claude account with subscription", () => {
      const { sends, watcher } = collect();
      watcher.push("Claude\x1b[1Caccount\x1b[1Cwith\x1b[1Csubscription\r\n");
      expect(sends).toEqual(["\r"]);
    });

    it("does not type /login itself when an initialized Claude install opens signed out", () => {
      const { sends, watcher } = collect();
      watcher.push(NOT_LOGGED_IN_OUTPUT);
      expect(sends).toEqual([]);
    });

    it("selects the Claude AI login method without injecting a slash command", () => {
      const { sends, watcher } = collect();
      watcher.push(NOT_LOGGED_IN_OUTPUT);
      watcher.push(NOT_LOGGED_IN_OUTPUT); // redraw — must stay passive
      watcher.push(LOGIN_OUTPUT);
      watcher.push(LOGIN_OUTPUT); // redraw — must not press again
      expect(sends).toEqual(["\r"]);
    });

    it("advances theme then login, one Enter per screen across chunks", () => {
      const { sends, watcher } = collect();
      watcher.push(THEME_OUTPUT);
      watcher.push(THEME_OUTPUT); // redraw — must not press again
      watcher.push(LOGIN_OUTPUT);
      watcher.push(LOGIN_OUTPUT); // redraw — must not press again
      expect(sends).toEqual(["\r", "\r"]);
    });

    it("advances theme then login on CHA-positioned screens (CLI 2.1.251)", () => {
      const { sends, watcher } = collect();
      watcher.push(THEME_OUTPUT_CHA);
      watcher.push(LOGIN_OUTPUT_CHA);
      expect(sends).toEqual(["\r", "\r"]);
    });

    it("caps retries for a stuck picker", () => {
      rs.useFakeTimers();
      const { sends, watcher } = collect();
      watcher.push(LOGIN_OUTPUT);

      rs.advanceTimersByTime(60_000);
      expect(sends).toHaveLength(8);
    });

    it("never writes to the PTY when no send callback is provided", () => {
      const events: ClaudeLoginEvent[] = [];
      const watcher = createClaudeLoginWatcher((e) => events.push(e));
      // Must not throw despite recognising the wizard screens.
      expect(() => {
        watcher.push(THEME_OUTPUT);
        watcher.push(LOGIN_OUTPUT);
      }).not.toThrow();
    });
  });
});
