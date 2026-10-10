import { describe, expect, it } from "@rstest/core";
import {
  adhocSessionKey,
  forkSessionKey,
  LARGE_MODEL_MARKER,
  subagentSessionKey,
  WEBCHAT_KEY_PREFIX,
  webchatSessionKey,
} from "./agent-session-key.js";

// Stored rows look sessions up by these exact strings, so a builder that
// changes its output strands every existing provider thread.
describe("agent session keys", () => {
  it("spells webchat keys as stored rows expect", () => {
    expect(webchatSessionKey("chat-1")).toBe("webchat:chat-1");
    expect(webchatSessionKey("chat-1", "sel-a")).toBe("webchat:chat-1:large-model:sel-a");
    expect(webchatSessionKey("chat-1", "sel-a").startsWith(WEBCHAT_KEY_PREFIX)).toBe(true);
    expect(webchatSessionKey("chat-1", "sel-a")).toContain(LARGE_MODEL_MARKER);
  });

  it("nests subagent and fork keys under their parent", () => {
    expect(subagentSessionKey("webchat:chat-1")).toMatch(/^webchat:chat-1:subagent:[0-9a-f-]{36}$/);
    expect(subagentSessionKey("webchat:chat-1")).not.toBe(subagentSessionKey("webchat:chat-1"));
    expect(forkSessionKey("webchat:chat-1", "fork-1")).toBe("webchat:chat-1#fork:fork-1");
  });

  it("gives each ad-hoc run a fresh key under its agent", () => {
    expect(adhocSessionKey("main")).toMatch(/^main:[0-9a-f-]{36}$/);
    expect(adhocSessionKey("main")).not.toBe(adhocSessionKey("main"));
  });
});
