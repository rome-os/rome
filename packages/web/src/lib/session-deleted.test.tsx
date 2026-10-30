// @rstest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { deleteSession } from "./chat-api";
import { emitSessionDeleted, useSessionDeleted } from "./session-deleted";

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("session deletes", () => {
  it("reach the components listening, with the deleted id", () => {
    const heard = rs.fn();
    const { unmount } = renderHook(() => useSessionDeleted(heard));

    emitSessionDeleted("session-1");
    expect(heard).toHaveBeenCalledExactlyOnceWith("session-1");

    unmount();
    emitSessionDeleted("session-2");
    expect(heard).toHaveBeenCalledOnce();
  });

  it("are announced by deleteSession once the server accepted the delete", async () => {
    const heard = rs.fn();
    renderHook(() => useSessionDeleted(heard));

    rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await deleteSession("session-1");
    expect(heard).not.toHaveBeenCalled();

    rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await deleteSession("session-1");
    expect(heard).toHaveBeenCalledExactlyOnceWith("session-1");
  });
});
