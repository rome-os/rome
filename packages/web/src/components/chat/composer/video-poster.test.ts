// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { captureVideoPoster } from "./video-poster";

interface Clip {
  width?: number;
  height?: number;
  duration?: number;
  /** Mean luma of the frame at a time, 0–255. */
  luma?: (seconds: number) => number;
  /** Never fire `loadedmetadata`, as a stalled load does not. */
  stall?: boolean;
  /** Fire `error` instead of `loadedmetadata`, as an undecodable file does. */
  undecodable?: boolean;
}

class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  preload = "";
  released = false;
  private time = 0;

  constructor(private readonly clip: Clip) {
    super();
  }

  get videoWidth() {
    return this.clip.width ?? 1280;
  }
  get videoHeight() {
    return this.clip.height ?? 720;
  }
  get duration() {
    return this.clip.duration ?? 10;
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(seconds: number) {
    this.time = seconds;
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }
  set src(_: string) {
    if (this.clip.stall) return;
    const event = this.clip.undecodable ? "error" : "loadedmetadata";
    queueMicrotask(() => this.dispatchEvent(new Event(event)));
  }
  luma(seconds: number) {
    return this.clip.luma?.(seconds) ?? 128;
  }
  removeAttribute() {}
  load() {
    this.released = true;
  }
}

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    /** The video time each draw captured. */
    drawnAt: [] as number[],
    luma: 0,
    getContext: () => ({
      canvas,
      drawImage: (video: FakeVideo) => {
        canvas.drawnAt.push(video.currentTime);
        canvas.luma = video.luma(video.currentTime);
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(canvas.luma),
      }),
    }),
    toBlob: (done: (blob: Blob) => void, type: string) =>
      done(new Blob([`${canvas.width}x${canvas.height}@${canvas.drawnAt.at(-1)}`], { type })),
  };
  return canvas;
}

function stage(clip: Clip) {
  const video = new FakeVideo(clip);
  const original = document.createElement.bind(document);
  rs.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "video") return video;
    if (tag === "canvas") return fakeCanvas();
    return original(tag);
  }) as typeof document.createElement);
  return video;
}

afterEach(() => {
  rs.restoreAllMocks();
  rs.useRealTimers();
});

describe("captureVideoPoster", () => {
  it("captures the first frame at the video's size with its duration", async () => {
    const video = stage({ duration: 42.5 });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(await poster.blob.text()).toBe("1280x720@0");
    expect(poster.blob.type).toBe("image/jpeg");
    expect(poster.duration).toBe(42.5);
    expect(video.muted).toBe(true);
    expect(video.released).toBe(true);
  });

  it("caps the long edge at 1920px and keeps the aspect", async () => {
    stage({ width: 2160, height: 3840 });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(await poster.blob.text()).toBe("1080x1920@0");
  });

  it("looks one second in when the first frame is black", async () => {
    stage({ luma: (seconds) => (seconds < 0.5 ? 4 : 120) });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(await poster.blob.text()).toBe("1280x720@1");
  });

  it("looks at the midpoint of a clip shorter than two seconds", async () => {
    stage({ duration: 1.2, luma: (seconds) => (seconds === 0 ? 0 : 200) });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(await poster.blob.text()).toBe("1280x720@0.6");
  });

  it("keeps the first frame of a video that stays dark", async () => {
    stage({ luma: () => 3 });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(await poster.blob.text()).toBe("1280x720@0");
  });

  it("reports no duration for a stream without a finite one", async () => {
    stage({ duration: Number.POSITIVE_INFINITY });
    const poster = await captureVideoPoster("blob:clip", new AbortController().signal);
    expect(poster.duration).toBeNull();
  });

  it("rejects a video the browser cannot decode and one without a picture", async () => {
    const undecodable = stage({ undecodable: true });
    await expect(captureVideoPoster("blob:clip", new AbortController().signal)).rejects.toThrow(
      "cannot decode",
    );
    expect(undecodable.released).toBe(true);
    rs.restoreAllMocks();
    stage({ width: 0, height: 0 });
    await expect(captureVideoPoster("blob:clip", new AbortController().signal)).rejects.toThrow(
      "no picture",
    );
  });

  it("rejects on abort and after ten seconds without metadata", async () => {
    const aborted = stage({ stall: true });
    const controller = new AbortController();
    const capture = captureVideoPoster("blob:clip", controller.signal);
    controller.abort(new Error("removed"));
    await expect(capture).rejects.toThrow("removed");
    expect(aborted.released).toBe(true);

    rs.restoreAllMocks();
    rs.useFakeTimers();
    stage({ stall: true });
    const stalled = captureVideoPoster("blob:clip", new AbortController().signal);
    rs.advanceTimersByTime(10_000);
    await expect(stalled).rejects.toThrow("did not load in time");
  });
});
