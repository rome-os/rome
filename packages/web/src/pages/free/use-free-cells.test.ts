// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

beforeEach(() => {
  rs.resetModules();
  localStorage.clear();
  rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

afterEach(() => {
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("placeWidgetsIfSessionActive", () => {
  it("does not apply a delayed widget handoff after the active session changes", async () => {
    const { placeWidgetsIfSessionActive, setActiveSession } = await import("./use-free-cells");

    setActiveSession("chat-a");
    setActiveSession("chat-b");

    expect(
      placeWidgetsIfSessionActive("chat-a", [
        { type: "app", appId: "nav-chat-probe", route: "from-chat-a" },
      ]),
    ).toBe(false);

    expect(localStorage.getItem("rome:free-layout:chat-b")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies a widget handoff when the target session is still active", async () => {
    const { placeWidgetsIfSessionActive, setActiveSession } = await import("./use-free-cells");

    setActiveSession("chat-a");

    expect(
      placeWidgetsIfSessionActive("chat-a", [
        { type: "app", appId: "nav-chat-probe", route: "from-chat-a" },
      ]),
    ).toBe(true);

    const layout = JSON.parse(localStorage.getItem("rome:free-layout:chat-a") ?? "[]") as Array<{
      targetId?: string;
      route?: string;
    }>;
    expect(layout).toEqual([
      expect.objectContaining({
        targetId: "nav-chat-probe",
        route: "from-chat-a",
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-a/layout",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("placeChatWidget", () => {
  it("places a pinned chat card once per session, keeping the placement id", async () => {
    const { placeChatWidget, setActiveSession } = await import("./use-free-cells");

    setActiveSession("layout-session");
    placeChatWidget("branch-1");

    const read = () =>
      JSON.parse(localStorage.getItem("rome:free-layout:layout-session") ?? "[]") as Array<{
        id: string;
        type: string;
        targetId?: string;
      }>;
    const layout = read();
    expect(layout).toEqual([expect.objectContaining({ type: "chat", targetId: "branch-1" })]);

    // Re-placing the same session is a no-op with a stable id — a fresh id
    // would remount the card and tear down its live stream.
    placeChatWidget("branch-1");
    const again = read();
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(layout[0].id);

    // A different session gets its own card.
    placeChatWidget("branch-2");
    expect(read()).toHaveLength(2);
  });
});
