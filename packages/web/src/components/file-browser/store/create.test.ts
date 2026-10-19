import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { toast } from "sonner";
import type { TFunction } from "i18next";
import { createFileBrowserStore } from "./create";

rs.mock("sonner", () => ({ toast: { success: rs.fn(), error: rs.fn() } }));

function createTestStore() {
  return createFileBrowserStore({
    apiBasePath: "/api/files",
    logicalRootPath: "/projects",
    rootLabel: "projects",
    initialSelectedFolderPath: "/projects/current",
    queryClient: new QueryClient(),
    navigate: rs.fn(),
    getRouteSnapshot: () => ({ pathname: "/projects/current", search: "", hash: "" }),
    t: ((key: string) => key) as TFunction,
    embedded: false,
  });
}

describe("file-browser action selection", () => {
  it("prepares folder action paths without changing folder navigation", () => {
    const store = createTestStore();
    store.setState((state) => ({
      selection: {
        ...state.selection,
        selectedFolderPath: "/projects/current",
        selectedTreePaths: ["/projects/current"],
      },
      ui: { ...state.ui, filesPaneDrillPath: "/projects/current" },
    }));

    const paths = store
      .getState()
      .selection.prepareContextMenu({ path: "/projects/other", type: "directory" });

    expect(paths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedTreePaths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedFolderPath).toBe("/projects/current");
    expect(store.getState().ui.filesPaneDrillPath).toBe("/projects/current");
  });

  it("keeps a multi-selection in tree order and drops paths nested in a selected folder", () => {
    const store = createTestStore();
    store.setState((state) => ({
      selection: {
        ...state.selection,
        selectedTreePaths: ["/projects/zeta", "/projects/zeta/inner.md", "/projects/alpha.md"],
      },
    }));

    const paths = store
      .getState()
      .selection.prepareContextMenu({ path: "/projects/alpha.md", type: "file" });

    expect(paths).toEqual(["/projects/zeta", "/projects/alpha.md"]);
  });

  it("waits for the app confirmation dialog before discarding unsaved edits", async () => {
    const store = createTestStore();
    store.setState((state) => ({
      file: {
        ...state.file,
        selectedFile: {
          assetUrl: null,
          content: "saved",
          editable: true,
          kind: "text",
          mimeType: "text/plain",
          path: "/projects/current/notes.txt",
          size: 5,
        },
        content: "draft",
        committedContent: "saved",
        lastDiskContent: "saved",
      },
    }));

    const cancelled = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(store.getState().file.content).toBe("draft");

    const confirmed = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(true);
    await expect(confirmed).resolves.toBe(true);
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(false);
    expect(store.getState().file.content).toBe("saved");
  });
});

class MockUploadRequest {
  static instances: MockUploadRequest[] = [];
  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 200;
  responseText = "{}";
  open = rs.fn();
  send = rs.fn();

  constructor() {
    MockUploadRequest.instances.push(this);
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe("file-browser upload progress", () => {
  const entries = [
    { file: new File(["first"], "first.txt"), relativePath: "folder/first.txt" },
    { file: new File(["second"], "second.txt"), relativePath: "folder/second.txt" },
  ];

  beforeEach(() => {
    MockUploadRequest.instances = [];
    rs.stubGlobal("XMLHttpRequest", MockUploadRequest);
  });

  afterEach(() => {
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
    rs.clearAllMocks();
  });

  it("sends the same multipart fields and tracks transfer through the server response", async () => {
    const store = createTestStore();
    const loadAncestors = rs
      .spyOn(store.getState().tree, "loadDirectoryAncestors")
      .mockResolvedValue();
    const loadFile = rs.spyOn(store.getState().file, "loadFile").mockResolvedValue("loaded");
    expect(store.getState().ui.uploadProgress).toBeNull();

    const pending = store.getState().ui.uploadFiles(entries, "/projects/target");
    const xhr = MockUploadRequest.instances[0];
    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/files/file");
    const body = xhr.send.mock.calls[0][0] as FormData;
    expect(body.get("path")).toBe("/projects/target");
    expect(body.getAll("paths")).toEqual(["folder/first.txt", "folder/second.txt"]);
    expect(body.getAll("files").map((file) => (file as File).name)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(store.getState().ui.uploadProgress).toEqual({
      fileCount: 2,
      firstFileName: "first.txt",
      loaded: 0,
      total: 0,
      phase: "uploading",
    });

    xhr.progress(25, 100);
    expect(store.getState().ui.uploadProgress).toMatchObject({
      loaded: 25,
      total: 100,
      phase: "uploading",
    });
    xhr.progress(100, 100);
    expect(store.getState().ui.uploadProgress?.phase).toBe("finishing");
    xhr.upload.onload?.();
    expect(store.getState().ui.uploadProgress?.phase).toBe("finishing");
    expect(toast.success).not.toHaveBeenCalled();

    xhr.respond(200, {
      files: [{ path: "/projects/target/folder/first.txt", size: 5 }],
      message: "Uploaded",
    });
    await pending;
    expect(loadAncestors).toHaveBeenCalledWith("/projects/target/folder/first.txt");
    expect(loadFile).toHaveBeenCalledWith("/projects/target/folder/first.txt", {});
    expect(toast.success).toHaveBeenCalledWith("Uploaded");
    expect(store.getState().ui.uploadProgress).toBeNull();
  });

  it("keeps unknown totals indeterminate and finishes when the request body is sent", async () => {
    const store = createTestStore();
    const loadRoot = rs.spyOn(store.getState().tree, "loadRoot").mockResolvedValue([]);
    const pending = store.getState().ui.uploadFiles(entries);
    const xhr = MockUploadRequest.instances[0];
    expect((xhr.send.mock.calls[0][0] as FormData).get("path")).toBe("/projects/current");
    xhr.progress(12, 100, false);
    expect(store.getState().ui.uploadProgress).toMatchObject({
      loaded: 12,
      total: 0,
      phase: "uploading",
    });
    xhr.upload.onload?.();
    expect(store.getState().ui.uploadProgress?.phase).toBe("finishing");
    xhr.respond(200, {});
    await pending;
    expect(loadRoot).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("status.uploadedFiles");
    expect(store.getState().ui.uploadProgress).toBeNull();
  });

  it.each([
    [{ error: "Disk full" }, "Disk full"],
    [{}, "status.uploadFailed"],
  ])("resets progress after an HTTP error (%j)", async (body, message) => {
    const store = createTestStore();
    const pending = store.getState().ui.uploadFiles(entries);
    MockUploadRequest.instances[0].respond(500, body);
    await pending;
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(store.getState().ui.uploadProgress).toBeNull();
  });

  it.each([
    "onerror",
    "onabort",
    "ontimeout",
  ] as const)("resets progress after %s", async (event) => {
    const store = createTestStore();
    const pending = store.getState().ui.uploadFiles(entries);
    MockUploadRequest.instances[0][event]?.();
    await pending;
    expect(toast.error).toHaveBeenCalledWith("status.networkError");
    expect(store.getState().ui.uploadProgress).toBeNull();
  });

  it("preserves the network error toast for malformed JSON", async () => {
    const store = createTestStore();
    const pending = store.getState().ui.uploadFiles(entries);
    MockUploadRequest.instances[0].responseText = "not JSON";
    MockUploadRequest.instances[0].onload?.();
    await pending;
    expect(toast.error).toHaveBeenCalledWith("status.networkError");
    expect(store.getState().ui.uploadProgress).toBeNull();
  });

  it("rejects a second batch while one is in flight and keeps the first batch tracked", async () => {
    const store = createTestStore();
    rs.spyOn(store.getState().tree, "loadRoot").mockResolvedValue([]);
    const first = store.getState().ui.uploadFiles(entries);
    MockUploadRequest.instances[0].progress(40, 100);

    await store.getState().ui.uploadFiles([entries[0]]);
    expect(MockUploadRequest.instances).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith("status.uploadInProgress");
    expect(store.getState().ui.uploadProgress).toMatchObject({ fileCount: 2, loaded: 40 });

    MockUploadRequest.instances[0].respond(200, {});
    await first;
    expect(store.getState().ui.uploadProgress).toBeNull();

    const next = store.getState().ui.uploadFiles([entries[0]]);
    expect(MockUploadRequest.instances).toHaveLength(2);
    MockUploadRequest.instances[1].respond(200, {});
    await next;
  });

  it("does not start an empty or cancelled upload", async () => {
    const store = createTestStore();
    await store.getState().ui.uploadFiles([]);
    rs.spyOn(store.getState().file, "hasUnsavedEdits").mockReturnValue(true);
    rs.spyOn(store.getState().file, "resolveUnsavedEditsBeforeLeaving").mockResolvedValue(false);
    await store.getState().ui.uploadFiles(entries);
    expect(MockUploadRequest.instances).toHaveLength(0);
    expect(store.getState().ui.uploadProgress).toBeNull();
  });
});
