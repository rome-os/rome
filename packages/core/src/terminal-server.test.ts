import { describe, expect, it } from "@rstest/core";
import { TERMINAL_COMMAND_PRESETS } from "./terminal-server.js";

describe("TERMINAL_COMMAND_PRESETS", () => {
  it("logs in via `claude /login` — the watcher auto-drives the first-run choices", () => {
    expect(TERMINAL_COMMAND_PRESETS["claude-login"]).toEqual({
      cmd: "claude",
      args: ["/login"],
    });
  });

  it("exposes only the login preset — logout (Claude + Codex) is non-PTY", () => {
    // Logout runs via HTTP endpoints (`claude auth logout` / the app-server
    // `account/logout` RPC), and Codex login uses the device-code flow. None of
    // them is a PTY preset.
    expect(Object.keys(TERMINAL_COMMAND_PRESETS)).toEqual(["claude-login"]);
    expect(TERMINAL_COMMAND_PRESETS["claude-logout"]).toBeUndefined();
    expect(TERMINAL_COMMAND_PRESETS["codex-login"]).toBeUndefined();
  });
});
