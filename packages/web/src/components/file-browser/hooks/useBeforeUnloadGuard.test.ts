// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, renderHook } from "@testing-library/react";
import { useBeforeUnloadGuard } from "./useBeforeUnloadGuard";

const { state, store } = rs.hoisted(() => {
  const state = {
    ui: { uploadProgress: null as object | null },
    file: {
      _suppressNextBeforeUnload: false,
      _manualSaveInFlight: false,
      _autoSaveCanRecover: false,
      hasUnsavedEdits: rs.fn().mockReturnValue(false),
    },
  };
  return { state, store: { getState: () => state } };
});

const ACTIVE_UPLOAD = {
  fileCount: 1,
  firstFileName: "a.txt",
  loaded: 0,
  total: 0,
  phase: "uploading",
};

rs.mock("../store/context", () => ({
  useFileBrowserStoreApi: () => store,
  useFileBrowserStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

function tryLeaving() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  state.ui.uploadProgress = null;
  state.file._suppressNextBeforeUnload = false;
  state.file._manualSaveInFlight = false;
  state.file._autoSaveCanRecover = false;
  state.file.hasUnsavedEdits.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("useBeforeUnloadGuard", () => {
  it("protects the upload until completion and removes its listener afterwards", () => {
    const remove = rs.spyOn(window, "removeEventListener");
    const { rerender, unmount } = renderHook(() => useBeforeUnloadGuard());
    expect(tryLeaving()).toBe(false);
    state.ui.uploadProgress = ACTIVE_UPLOAD;
    rerender();
    expect(tryLeaving()).toBe(true);
    state.ui.uploadProgress = null;
    rerender();
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(tryLeaving()).toBe(false);
    state.ui.uploadProgress = ACTIVE_UPLOAD;
    rerender();
    unmount();
    expect(tryLeaving()).toBe(false);
  });

  it("does not let an editor navigation exemption bypass upload protection", () => {
    state.ui.uploadProgress = ACTIVE_UPLOAD;
    state.file._suppressNextBeforeUnload = true;
    state.file._autoSaveCanRecover = true;
    renderHook(() => useBeforeUnloadGuard());
    expect(tryLeaving()).toBe(true);
  });

  it("preserves the unsaved-edit and manual-save guards", () => {
    renderHook(() => useBeforeUnloadGuard());
    state.file.hasUnsavedEdits.mockReturnValue(true);
    expect(tryLeaving()).toBe(true);
    state.file._autoSaveCanRecover = true;
    expect(tryLeaving()).toBe(false);
    state.file._manualSaveInFlight = true;
    expect(tryLeaving()).toBe(true);
  });
});
