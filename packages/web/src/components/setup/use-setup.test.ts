// @rstest-environment jsdom
//
// The useSetup polling runner drops local state on reset so the card can offer
// a fresh Connect, and a
// polled setup that has vanished (404) clears itself rather than sticking on a
// stale terminal view.

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSetup } from "@/components/setup/use-setup";

afterEach(() => rs.restoreAllMocks());

describe("useSetup stale-state handling", () => {
  it("reset() drops cid and state so a fresh Connect is possible", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: { status: "presenting", view: { title: "x" } } }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() =>
      useSetup({ idOrService: "discord", grant: "bot", activeCid: "cid-1" }),
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
      useSetup({ idOrService: "discord", grant: "bot", activeCid: "gone" }),
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
        idOrService: "github",
        grant: "user",
        activeCid: "cid-parked",
        pollMs: 10,
        onDone,
      }),
    );

    // Reaching `done` with no further input IS the proof: before this polled
    // `awaiting-redirect`, the hook settled on the parked state and stopped
    // asking, so the second answer could never arrive. Asserting the
    // intermediate state instead would race the next tick.
    await waitFor(() => expect(result.current.state?.status).toBe("done"));
    expect(polls).toBeGreaterThan(1);
    expect(onDone).toHaveBeenCalled();
  });
});
