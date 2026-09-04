// @rstest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import TerminalModal from "./terminal-modal";

// Minimal WebSocket stand-in: the modal only needs `onopen` to fire so it
// enters the "connected" state and starts polling. It never renders raw output.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason?: string }) => void) | null = null;
  constructor() {
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.useRealTimers();
  MockWebSocket.instances = [];
});

describe("TerminalModal Claude login completion", () => {
  it("detects a completed login by re-probing POST /ai-tools/refresh, not the cached status", async () => {
    rs.useFakeTimers();
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

    const calls: Array<{ url: string; method: string }> = [];
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/ai-tools/refresh") {
        return Response.json({ claude: { loggedIn: true }, codex: { loggedIn: false } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch);

    const onClose = rs.fn();
    render(<TerminalModal preset="claude-login" onClose={onClose} />);

    // Drive the socket open so the modal starts its completion poll.
    await act(async () => {
      MockWebSocket.instances[0]?.onopen?.();
    });

    // First poll tick fires the re-probe.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2000);
    });

    const refreshCalls = calls.filter((c) => c.url === "/api/ai-tools/refresh");
    expect(refreshCalls.length).toBeGreaterThan(0);
    expect(refreshCalls.every((c) => c.method === "POST")).toBe(true);
    // The cached status endpoint must not be the completion signal.
    expect(calls.some((c) => c.url === "/api/ai-tools/status")).toBe(false);

    // Success lands, then the dialog closes itself after the success beat.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(1200);
    });
    expect(onClose).toHaveBeenCalled();
  });
});
