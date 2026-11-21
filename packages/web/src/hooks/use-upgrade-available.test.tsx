// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  isNewerVersion,
  offeredVersion,
  UPGRADE_CHECK_INTERVAL_MS,
  useUpgradeAvailable,
} from "./use-upgrade-available";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  rs.useRealTimers();
  setVisibility("visible");
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

// Rome Cloud's flag is true for any mismatch, a rollback included.
function check(current: string | null, latest: string) {
  return {
    current: { version: current, sha: "abc1234" },
    latest: { version: latest },
    upgradeAvailable: current !== latest,
  };
}

/** Serves the upgrade check from `next()`, counting requests. */
function mockCheck(next: () => { status: number; body: unknown }) {
  const calls = { count: 0 };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/system/upgrade/check") throw new Error(`unexpected ${input}`);
    calls.count += 1;
    const { status, body } = next();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

function renderAvailability(enabled = true) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUpgradeAvailable(enabled), { wrapper });
}

describe("isNewerVersion", () => {
  it("orders release versions numerically", () => {
    expect(isNewerVersion("1.1.186", "1.1.185")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.1.999")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.1.10", "1.1.9")).toBe(true);
    expect(isNewerVersion("v1.1.186", "1.1.185")).toBe(true);
  });

  it("never offers an equal or older version", () => {
    expect(isNewerVersion("1.1.185", "1.1.185")).toBe(false);
    // A test image or a rollback runs ahead of the published latest.
    expect(isNewerVersion("1.1.185", "1.1.190")).toBe(false);
    expect(isNewerVersion("1.1.9", "1.1.10")).toBe(false);
  });

  it("offers nothing for versions it can't order", () => {
    expect(isNewerVersion("1.2.0-rc.1", "1.1.0")).toBe(false);
    expect(isNewerVersion("latest", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.2.0", "dev")).toBe(false);
    expect(isNewerVersion("1.2", "1.1.0")).toBe(false);
  });
});

describe("offeredVersion", () => {
  it("needs both Rome Cloud's flag and a strictly newer latest", () => {
    expect(offeredVersion(check("1.1.0", "1.2.0"))).toBe("1.2.0");
    expect(offeredVersion(check("1.3.0", "1.2.0"))).toBeNull();
    expect(offeredVersion({ ...check("1.1.0", "1.2.0"), upgradeAvailable: false })).toBeNull();
    expect(offeredVersion(check(null, "1.2.0"))).toBeNull();
  });
});

describe("useUpgradeAvailable", () => {
  it("checks once the browser is idle, not during the first render", async () => {
    let idle: (() => void) | undefined;
    rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idle = cb;
      return 1;
    });
    rs.stubGlobal("cancelIdleCallback", () => {});
    const calls = mockCheck(() => ({ status: 200, body: check("1.1.0", "1.2.0") }));
    const { result } = renderAvailability();

    expect(calls.count).toBe(0);
    act(() => idle?.());

    await waitFor(() => expect(result.current.latest).toBe("1.2.0"));
    expect(calls.count).toBe(1);
  });

  it("falls back to a timer without requestIdleCallback, then re-checks every 15 minutes", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    rs.stubGlobal("requestIdleCallback", undefined);
    let latest = "1.1.0";
    const calls = mockCheck(() => ({ status: 200, body: check("1.1.0", latest) }));
    const { result } = renderAvailability();

    await rs.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(calls.count).toBe(1));
    expect(result.current.latest).toBeNull();

    latest = "1.1.1";
    await rs.advanceTimersByTimeAsync(UPGRADE_CHECK_INTERVAL_MS);
    await waitFor(() => expect(result.current.latest).toBe("1.1.1"));
    expect(calls.count).toBe(2);
  });

  it("waits for a hidden tab to be shown before the first check", async () => {
    setVisibility("hidden");
    rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    rs.stubGlobal("cancelIdleCallback", () => {});
    const calls = mockCheck(() => ({ status: 200, body: check("1.1.0", "1.2.0") }));
    const { result } = renderAvailability();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.count).toBe(0);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(result.current.latest).toBe("1.2.0"));
  });

  it("offers nothing when the check fails, and drops an earlier offer", async () => {
    rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    rs.stubGlobal("cancelIdleCallback", () => {});
    const responses = [
      { status: 200, body: check("1.1.0", "1.2.0") },
      { status: 503, body: { error: "pantheon_unconfigured" } },
    ];
    mockCheck(() => responses.shift() ?? { status: 502, body: { error: "pantheon_unreachable" } });
    const { result } = renderAvailability();

    await waitFor(() => expect(result.current.latest).toBe("1.2.0"));
    await act(async () => {
      await result.current.recheck();
    });
    await waitFor(() => expect(result.current.latest).toBeNull());
  });

  it("offers nothing on an unversioned build", async () => {
    rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    rs.stubGlobal("cancelIdleCallback", () => {});
    const calls = mockCheck(() => ({ status: 200, body: check(null, "1.2.0") }));
    const { result } = renderAvailability();

    await waitFor(() => expect(calls.count).toBe(1));
    expect(result.current.latest).toBeNull();
  });

  it("does not check at all when disabled (a visitor)", async () => {
    rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
      cb();
      return 1;
    });
    rs.stubGlobal("cancelIdleCallback", () => {});
    const calls = mockCheck(() => ({ status: 200, body: check("1.1.0", "1.2.0") }));
    renderAvailability(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.count).toBe(0);
  });
});
