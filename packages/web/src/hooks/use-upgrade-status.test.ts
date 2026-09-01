// @rstest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  UPGRADE_RESTART_TIMEOUT_MS,
  UPGRADE_STATUS_ACTIVE_POLL_MS,
  UPGRADE_STATUS_IDLE_POLL_MS,
  UPGRADE_STATUS_POLL_TIMEOUT_MS,
  UPGRADE_VERB_TIMEOUT_MS,
  type UpgradeStatus,
  useUpgradeStatus,
} from "./use-upgrade-status";

type ServerUpgradeStatus = Omit<UpgradeStatus, "receivedAt">;

function jsonResponse(status: ServerUpgradeStatus): Response {
  return new Response(JSON.stringify(status), {
    headers: { "Content-Type": "application/json" },
  });
}

const idleStatus: ServerUpgradeStatus = {
  phase: "idle",
  targetVersion: null,
  deadline: null,
  serverNow: 1_000,
};

function countdownStatus(overrides: Partial<ServerUpgradeStatus> = {}): ServerUpgradeStatus {
  return {
    phase: "countdown",
    targetVersion: "1.2.0",
    deadline: Date.now() + 600_000,
    serverNow: Date.now(),
    ...overrides,
  };
}

function updatingStatus(): ServerUpgradeStatus {
  return { phase: "updating", targetVersion: "1.2.0", deadline: null, serverNow: Date.now() };
}

describe("useUpgradeStatus", () => {
  beforeEach(() => {
    rs.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    rs.useRealTimers();
    rs.unstubAllGlobals();
    rs.clearAllMocks();
  });

  it("hides the banner while idle and polls at the slow cadence", async () => {
    const fetchMock = rs.fn().mockResolvedValue(jsonResponse(idleStatus));
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/upgrade/status/snapshot",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
    expect(result.current.state).toBeNull();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_IDLE_POLL_MS - 1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("shows the countdown and speeds up polling when a countdown is discovered", async () => {
    const fetchMock = rs.fn().mockResolvedValue(jsonResponse(countdownStatus()));
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    expect(result.current.state).toMatchObject({ phase: "countdown", targetVersion: "1.2.0" });

    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    unmount();
  });

  it("updateNow applies the acked updating snapshot immediately", async () => {
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(jsonResponse(countdownStatus()))
      .mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === "POST" ? jsonResponse(updatingStatus()) : jsonResponse(countdownStatus()),
      );
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    await act(async () => {
      await result.current.updateNow();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/upgrade/now",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(result.current.state?.phase).toBe("updating");

    unmount();
  });

  it("defer applies the reverted snapshot and hides the banner", async () => {
    // Stateful stub: the defer POST reverts the server to idle, and every
    // later poll observes that — mirroring the real hub.
    let current: ServerUpgradeStatus = countdownStatus();
    const fetchMock = rs.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") current = idleStatus;
      return jsonResponse(current);
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    await act(async () => {
      await result.current.defer();
    });

    expect(result.current.state).toBeNull();

    unmount();
  });

  it("stays in updating through failed polls and clears on the first idle answer", async () => {
    let serverUp = true;
    const fetchMock = rs.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(updatingStatus());
      if (!serverUp) throw new TypeError("fetch failed");
      return jsonResponse(countdownStatus());
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    await act(async () => {
      await result.current.updateNow();
    });
    expect(result.current.state?.phase).toBe("updating");

    // The restart begins: every poll fails. The banner must not flinch.
    serverUp = false;
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS * 5);
    });
    expect(result.current.state?.phase).toBe("updating");

    // The replacement process is up and answers idle: banner clears.
    fetchMock.mockImplementation(async () => jsonResponse(idleStatus));
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS);
    });
    expect(result.current.state).toBeNull();

    unmount();
  });

  it("enters updating locally when the countdown deadline crosses zero", async () => {
    // A fixed deadline, but a live serverNow: each poll answers with the same
    // countdown as a real server would while its deadline-path relay to
    // Rome Cloud is still in flight.
    const deadline = Date.now() + 2_000;
    const fetchMock = rs
      .fn()
      .mockImplementation(async () => jsonResponse(countdownStatus({ deadline })));
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    expect(result.current.state?.phase).toBe("countdown");

    // The server keeps answering with the (now expired) countdown while its
    // own deadline-path relay to Rome Cloud is in flight — the client must not
    // flap back out of updating on those polls.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS * 2);
    });
    expect(result.current.state?.phase).toBe("updating");

    unmount();
  });

  it("a stale poll resolving after the update-now ack cannot revert the banner", async () => {
    let resolveStalePoll!: (response: Response) => void;
    let getCount = 0;
    const fetchMock = rs.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(updatingStatus()));
      getCount += 1;
      if (getCount === 1) return Promise.resolve(jsonResponse(countdownStatus()));
      // Every later GET hangs until released — the second one is the poll
      // that is still in flight when the ack lands.
      return new Promise<Response>((resolve) => {
        resolveStalePoll = resolve;
      });
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    expect(result.current.state?.phase).toBe("countdown");

    await act(async () => {
      await result.current.updateNow();
    });
    expect(result.current.state?.phase).toBe("updating");

    // The pre-ack poll finally answers with the old countdown: it must be
    // discarded, not applied — otherwise the banner reverts to a dead
    // countdown for the whole restart window.
    await act(async () => {
      resolveStalePoll(jsonResponse(countdownStatus()));
    });
    expect(result.current.state?.phase).toBe("updating");

    unmount();
  });

  it("a hung update-now POST is timed out and optimistically enters updating", async () => {
    let getCount = 0;
    const fetchMock = rs.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        // The restart severed the connection: the ack never arrives, only the
        // client-side deadline settles the request.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      getCount += 1;
      if (getCount === 1) return Promise.resolve(jsonResponse(countdownStatus()));
      return Promise.reject(new TypeError("fetch failed"));
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    expect(result.current.state?.phase).toBe("countdown");

    let acked: boolean | undefined;
    await act(async () => {
      const pending = result.current.updateNow().then((ok) => {
        acked = ok;
      });
      await rs.advanceTimersByTimeAsync(UPGRADE_VERB_TIMEOUT_MS);
      await pending;
    });
    expect(acked).toBe(true);
    expect(result.current.state?.phase).toBe("updating");

    unmount();
  });

  it("a transport-failed update-now shows updating and self-corrects once the grace passes", async () => {
    const fetchMock = rs.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("fetch failed");
      return jsonResponse(countdownStatus());
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    // The failure is ambiguous — the apply may have landed and the restart
    // severed the ack — so the banner optimistically reports updating.
    await act(async () => {
      await result.current.updateNow();
    });
    expect(result.current.state?.phase).toBe("updating");

    // Live-countdown polls inside the grace window are NOT proof of failure:
    // the server may still be mid-relay behind that countdown.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS);
    });
    expect(result.current.state?.phase).toBe("updating");

    // A countdown that outlives the whole relay budget proves the cutover
    // never committed: the banner self-corrects and the retry is available.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_VERB_TIMEOUT_MS);
    });
    expect(result.current.state?.phase).toBe("countdown");

    // A transport-failed defer has no restart to blame: it reports failure.
    let deferOk: boolean | undefined;
    await act(async () => {
      deferOk = await result.current.defer();
    });
    expect(deferOk).toBe(false);
    expect(result.current.state?.phase).toBe("countdown");

    unmount();
  });

  it("a severed update-now survives a mid-relay countdown poll and the restart that follows", async () => {
    // The race: the POST dies client-side while the server is still relaying
    // to Rome Cloud behind a live countdown. A poll observes that countdown,
    // then Rome Cloud accepts and the process dies before any poll can observe
    // `updating` — the client must ride through on its local state alone.
    let serverPhase: "countdown" | "down" | "idle" = "countdown";
    const fetchMock = rs.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("fetch failed");
      if (serverPhase === "down") throw new TypeError("fetch failed");
      return jsonResponse(serverPhase === "idle" ? idleStatus : countdownStatus());
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});

    await act(async () => {
      await result.current.updateNow();
    });
    expect(result.current.state?.phase).toBe("updating");

    // Mid-relay: the server still answers with the live countdown.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS);
    });
    expect(result.current.state?.phase).toBe("updating");

    // Rome Cloud accepted; the process dies without any poll seeing `updating`.
    serverPhase = "down";
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS * 4);
    });
    expect(result.current.state?.phase).toBe("updating");

    // The replacement process reports idle: converged.
    serverPhase = "idle";
    await act(async () => {
      await rs.advanceTimersByTimeAsync(
        UPGRADE_STATUS_ACTIVE_POLL_MS + UPGRADE_STATUS_POLL_TIMEOUT_MS,
      );
    });
    expect(result.current.state).toBeNull();

    unmount();
  });

  it("a poll that never settles is timed out so the loop keeps probing", async () => {
    let hang = true;
    const fetchMock = rs.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (!hang) return Promise.resolve(jsonResponse(idleStatus));
      // A half-open request: never settles on its own, only via abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The request deadline fires, the loop schedules the next poll, and once
    // the server answers again the hook converges — a single hung request
    // must never strand the recovery loop.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_POLL_TIMEOUT_MS);
    });
    hang = false;
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_IDLE_POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.state).toBeNull();

    unmount();
  });

  it("turns stalled after the restart timeout, dismissably, while continuing to poll", async () => {
    const fetchMock = rs.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(updatingStatus());
      throw new TypeError("fetch failed");
    });
    rs.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpgradeStatus());
    await act(async () => {});
    await act(async () => {
      await result.current.updateNow();
    });

    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_RESTART_TIMEOUT_MS + 1_000);
    });
    expect(result.current.state?.phase).toBe("stalled");

    act(() => {
      result.current.dismissStalled();
    });
    expect(result.current.state).toBeNull();

    // Past the stall boundary the cadence relaxes to the idle rate — a dead
    // server must not be hammered every 3s forever — but recovery polling
    // never stops: when the server finally answers idle, the stale updating
    // state is fully reset.
    const pollsAtStall = fetchMock.mock.calls.length;
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_ACTIVE_POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(pollsAtStall);

    fetchMock.mockImplementation(async () => jsonResponse(idleStatus));
    await act(async () => {
      await rs.advanceTimersByTimeAsync(UPGRADE_STATUS_IDLE_POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(pollsAtStall);
    expect(result.current.state).toBeNull();

    unmount();
  });
});
