export interface VideoPoster {
  /** A JPEG of one frame at the video's display aspect, at most 1920px on its long edge. */
  blob: Blob;
  /** Seconds, or null when the container does not state a finite duration. */
  duration: number | null;
}

// The poster is also the viewer's opening frame, and the viewer never scales a
// raster past its natural size, so this edge is the viewer's largest size too.
const MAX_EDGE = 1920;
const TIMEOUT_MS = 10_000;
// Mean luma, 0–255, under which a frame reads as black. A fade from black
// opens below it, and a dim but visible scene sits above it.
const DARK_LUMA = 16;
// How far in to look when the first frame is black. A fade-in is usually over
// by then, and a clip shorter than twice this length uses its midpoint.
const FALLBACK_SECONDS = 1;

function waitFor(video: HTMLVideoElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (done: () => void) => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      done();
    };
    const onEvent = () => settle(resolve);
    const onError = () => settle(() => reject(new Error("The browser cannot decode this video.")));
    const onAbort = () => settle(() => reject(signal.reason));
    if (signal.aborted) return onAbort();
    video.addEventListener(event, onEvent);
    video.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

async function seek(video: HTMLVideoElement, seconds: number, signal: AbortSignal) {
  const seeked = waitFor(video, "seeked", signal);
  // Assigning the current time still runs a seek, so this settles at 0 too.
  video.currentTime = seconds;
  await seeked;
}

function draw(
  video: HTMLVideoElement,
  width: number,
  height: number,
  options?: CanvasRenderingContext2DSettings,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", options);
  if (!context) throw new Error("Canvas 2D is unavailable.");
  context.drawImage(video, 0, 0, width, height);
  return context;
}

function isDark(video: HTMLVideoElement): boolean {
  const { data } = draw(video, 16, 16, { willReadFrequently: true }).getImageData(0, 0, 16, 16);
  let luma = 0;
  for (let i = 0; i < data.length; i += 4) {
    luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return luma / (data.length / 4) < DARK_LUMA;
}

/**
 * Capture a video's poster: its first frame, or the frame one second in when
 * the first is black. Rejects when the browser cannot decode the video, when
 * it has no picture (an audio-only `.m4v`), after ten seconds, or on abort.
 * The caller keeps `src` alive for the duration of the call.
 */
export async function captureVideoPoster(src: string, signal: AbortSignal): Promise<VideoPoster> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort);
  const timer = setTimeout(
    () => controller.abort(new Error("The video did not load in time.")),
    TIMEOUT_MS,
  );
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    const loaded = waitFor(video, "loadedmetadata", controller.signal);
    video.src = src;
    await loaded;
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) throw new Error("The video has no picture.");
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const scale = Math.min(1, MAX_EDGE / Math.max(videoWidth, videoHeight));
    const width = Math.round(videoWidth * scale);
    const height = Math.round(videoHeight * scale);

    await seek(video, 0, controller.signal);
    let frame = draw(video, width, height).canvas;
    if (duration && isDark(video)) {
      await seek(video, Math.min(FALLBACK_SECONDS, duration / 2), controller.signal);
      // A video that stays black is dark by design, and its first frame is
      // the truthful poster.
      if (!isDark(video)) frame = draw(video, width, height).canvas;
    }
    return { blob: await encode(frame, controller.signal), duration };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // Detaching the source releases the decoder now rather than at collection.
    video.removeAttribute("src");
    video.load();
  }
}

function encode(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (signal.aborted) reject(signal.reason);
        else if (blob) resolve(blob);
        else reject(new Error("The frame could not be encoded."));
      },
      "image/jpeg",
      0.85,
    );
  });
}
