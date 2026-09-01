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
