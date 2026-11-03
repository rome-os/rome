// @rstest-environment jsdom
//
// The useSetup polling runner drops local state on reset so the card can offer
// a fresh Connect, and a
// polled setup that has vanished (404) clears itself rather than sticking on a
// stale terminal view.

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSetup } from "@/components/setup/use-setup";

afterEach(() => {
  rs.useRealTimers();
  rs.restoreAllMocks();
});

describe("useSetup stale-state handling", () => {
  it("reset() drops cid and state so a fresh Connect is possible", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: { status: "presenting", view: { title: "x" } } }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() =>
      useSetup({ idOrKind: "discord", grant: "bot", activeCid: "cid-1" }),
    );
    // Adopted the discovered setup and polled its state.
    await waitFor(() => expect(result.current.state?.status).toBe("presenting"));
    expect(result.current.cid).toBe("cid-1");

    act(() => result.current.reset());
    expect(result.current.cid).toBeNull();
    expect(result.current.state).toBeNull();
  });

  it("clears itself when the polled setup has vanished (404)", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    const { result } = renderHook(() =>
      useSetup({ idOrKind: "discord", grant: "bot", activeCid: "gone" }),
    );
    // The immediate poll 404s → the hook resets so the card is not stuck.
    await waitFor(() => expect(result.current.cid).toBeNull());
    expect(result.current.state).toBeNull();
  });

  it("keeps polling while parked at the broker hand-off", async () => {
    // The desktop shell hands the redirect to the SYSTEM browser and this window
    // stays put, so the return leg resumes the coroutine somewhere else
    // entirely. Asking again is the only way this card ever learns it connected
    // — without it the guardian stares at an unchanged card until the
    // connections page's own refresh interval comes round.
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let polls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation(async () => {
      polls += 1;
      const state =
        polls > 1
          ? { status: "done" }
          : { status: "awaiting-redirect", url: "https://broker/authorize?state=xyz" };
      return new Response(JSON.stringify({ state }), { status: 200 });
    });
    const onDone = rs.fn();
    const { result } = renderHook(() =>
      useSetup({
        idOrKind: "github",
        grant: "user",
        activeCid: "cid-parked",
        onDone,
      }),
    );

    // Faked setInterval also stalls waitFor's polling, so drive the clock directly.
    await act(() => rs.advanceTimersByTimeAsync(0));
    expect(result.current.state?.status).toBe("awaiting-redirect");
    // Reaching `done` with no further input IS the proof: before this polled
    // `awaiting-redirect`, the hook settled on the parked state and stopped
    // asking, so the second answer could never arrive.
    await act(() => rs.advanceTimersByTimeAsync(2000));
    expect(result.current.state?.status).toBe("done");
    expect(polls).toBeGreaterThan(1);
    expect(onDone).toHaveBeenCalled();
  });

  it("cancels a new account's live setup when the card goes away", async () => {
    const started = JSON.stringify({
      cid: "cid-new",
      state: { status: "presenting", view: { title: "x" } },
    });
    const fetchMock = rs.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async () => new Response(started, { status: 200 }));
    const { result, unmount } = renderHook(() =>
      useSetup({ idOrKind: "feishu", grant: "bot", another: true }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.cid).toBe("cid-new"));

    unmount();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setups/cid-new/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("leaves an existing connection's setup running when the card goes away", async () => {
    const fetchMock = rs.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: { status: "presenting", view: { title: "x" } } }), {
        status: 200,
      }),
    );
    const { result, unmount } = renderHook(() =>
      useSetup({ idOrKind: "discord", grant: "bot", activeCid: "cid-1" }),
    );
    await waitFor(() => expect(result.current.state?.status).toBe("presenting"));

    unmount();

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
  });

  it("cancels a new account's setup that starts after the card went away", async () => {
    let answerStart: (response: Response) => void = () => {};
    const fetchMock = rs.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/cancel")) return new Response("{}", { status: 200 });
      return new Promise<Response>((resolve) => {
        answerStart = resolve;
      });
    });
    const { result, unmount } = renderHook(() =>
      useSetup({ idOrKind: "feishu", grant: "bot", another: true }),
    );
    act(() => result.current.start());

    unmount();
    const state = { status: "presenting", view: { title: "x" } };
    answerStart(new Response(JSON.stringify({ cid: "cid-late", state }), { status: 200 }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/setups/cid-late/cancel",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("cancels a new account's setup it re-attached to when the card goes away", async () => {
    const started = JSON.stringify({
      cid: "cid-other",
      reattached: true,
      state: { status: "presenting", view: { title: "x" } },
    });
    const fetchMock = rs.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async () => new Response(started, { status: 200 }));
    const { result, unmount } = renderHook(() =>
      useSetup({ idOrKind: "feishu", grant: "bot", another: true }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.cid).toBe("cid-other"));

    unmount();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setups/cid-other/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
