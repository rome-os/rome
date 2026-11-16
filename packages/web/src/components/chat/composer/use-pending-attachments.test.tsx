// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AttachmentUploadControls } from "./use-pending-attachments";
import { usePendingAttachments } from "./use-pending-attachments";

afterEach(cleanup);

const file = (name: string) => new File(["x"], name, { type: "text/plain" });

function startUpload(result: { current: ReturnType<typeof usePendingAttachments> }) {
  let controls!: AttachmentUploadControls;
  let finish!: () => void;
  let sent!: Promise<void>;
  act(() => {
    sent = result.current.track(result.current.uploads, (given) => {
      controls = given;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
  });
  return { controls: () => controls, finish: () => finish(), sent: () => sent };
}

describe("usePendingAttachments", () => {
  it("holds files until they are removed", () => {
    const { result } = renderHook(() => usePendingAttachments());
    act(() => result.current.add([file("a.txt"), file("b.txt")]));
    expect(result.current.uploads.map((upload) => upload.file.name)).toEqual(["a.txt", "b.txt"]);

    act(() => result.current.remove(result.current.uploads[0].id));
    expect(result.current.uploads.map((upload) => upload.file.name)).toEqual(["b.txt"]);
  });

  it("refuses changes to the tray while its upload is in flight", async () => {
    const { result } = renderHook(() => usePendingAttachments());
    act(() => result.current.add([file("a.txt")]));
    const upload = startUpload(result);
    expect(result.current.inFlight).toBe(true);
    expect(result.current.inFlightRef.current).toBe(true);
    expect(result.current.progress).toBe(0);

    act(() => result.current.add([file("late.txt")]));
    act(() => result.current.remove(result.current.uploads[0].id));
    expect(result.current.uploads.map((upload) => upload.file.name)).toEqual(["a.txt"]);

    await act(async () => {
      upload.finish();
      await upload.sent();
    });
    expect(result.current.inFlight).toBe(false);
    expect(result.current.inFlightRef.current).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("clamps reported progress to between 0 and 1", () => {
    const { result } = renderHook(() => usePendingAttachments());
    act(() => result.current.add([file("a.txt")]));
    const upload = startUpload(result);

    act(() => upload.controls().onUploadProgress(1.4));
    expect(result.current.progress).toBe(1);
    act(() => upload.controls().onUploadProgress(-0.2));
    expect(result.current.progress).toBe(0);
    act(() => upload.controls().onUploadProgress(null));
    expect(result.current.progress).toBeNull();
  });

  it("aborts the signal of the upload in flight on cancel", () => {
    const { result } = renderHook(() => usePendingAttachments());
    act(() => result.current.add([file("a.txt")]));
    const upload = startUpload(result);

    act(() => result.current.cancel());
    expect(upload.controls().signal.aborted).toBe(true);
  });

  it("leaves a send without attachments untracked", async () => {
    const { result } = renderHook(() => usePendingAttachments());
    const upload = startUpload(result);
    expect(result.current.inFlight).toBe(false);

    act(() => upload.controls().onUploadProgress(0.5));
    expect(result.current.progress).toBeNull();
    await act(async () => {
      upload.finish();
      await upload.sent();
    });
  });

  it("removes only the attachments that went out", () => {
    const { result } = renderHook(() => usePendingAttachments());
    act(() => result.current.add([file("a.txt")]));
    const sent = result.current.uploads;
    act(() => result.current.add([file("b.txt")]));

    act(() => result.current.removeSent(sent));
    expect(result.current.uploads.map((upload) => upload.file.name)).toEqual(["b.txt"]);
  });
});
