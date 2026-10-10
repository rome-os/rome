import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildGeminiVideoCookieHeader,
  buildGeminiVideoFileName,
  classifyGeminiVideoState,
  expandHomePath,
  formatBytes,
  formatDuration,
  GEMINI_VIDEO_DEFAULT_OUTPUT,
  geminiVideoPhaseBudgets,
  geminiVideoRatioLabel,
  geminiVideoStatusText,
  geminiVideoSubmissionError,
  integerInRange,
  isGeminiConversationUrl,
  isVideoContentType,
  parseGeminiVideoImages,
  pickGeminiVideoSource,
  resolveGeminiVideoOutputDir,
  summarizeGeminiVideoResult,
} from "./gemini-video-helpers.mjs";

const CLIP_URL =
  "https://contribution-rt.usercontent.google.com/download?c=CgxiYXJk&filename=video.mp4&opi=103135050";

test("geminiVideoRatioLabel maps ratios to Gemini menu entries", () => {
  assert.equal(geminiVideoRatioLabel("16:9"), "Landscape (16:9)");
  assert.equal(geminiVideoRatioLabel("9:16"), "Portrait (9:16)");
  assert.throws(() => geminiVideoRatioLabel("4:3"), /ratio must be one of: 16:9, 9:16/);
});

test("integerInRange accepts integers inside the range only", () => {
  assert.equal(integerInRange("600", "timeout", 30, 3600), 600);
  assert.throws(() => integerInRange(10, "timeout", 30, 3600), /timeout must be an integer/);
  assert.throws(() => integerInRange("1.5", "timeout", 30, 3600), /timeout must be an integer/);
});

test("expandHomePath resolves tilde and relative paths", () => {
  assert.equal(expandHomePath("~"), os.homedir());
  assert.equal(expandHomePath("~/tmp/x"), path.join(os.homedir(), "tmp", "x"));
  assert.equal(expandHomePath("clips"), path.resolve("clips"));
  assert.equal(expandHomePath("   "), "");
});

test("resolveGeminiVideoOutputDir falls back to the default directory", () => {
  assert.equal(resolveGeminiVideoOutputDir(""), expandHomePath(GEMINI_VIDEO_DEFAULT_OUTPUT));
  assert.equal(resolveGeminiVideoOutputDir("/tmp/out"), "/tmp/out");
});

test("parseGeminiVideoImages splits, resolves, and validates paths", () => {
  const exists = (file) => file.endsWith("a.jpg") || file.endsWith("b.png");
  assert.deepEqual(parseGeminiVideoImages("", { exists }), []);
  assert.deepEqual(parseGeminiVideoImages(" /x/a.jpg , /y/b.png ", { exists }), [
    "/x/a.jpg",
    "/y/b.png",
  ]);
  assert.throws(() => parseGeminiVideoImages("/x/missing.jpg", { exists }), /image not found/);
  assert.throws(() => parseGeminiVideoImages("/x/a.txt", { exists }), /must be one of/);
  const many = Array.from({ length: 11 }, (_, i) => `/x/${i}a.jpg`).join(",");
  assert.throws(() => parseGeminiVideoImages(many, { exists }), /at most 10 files/);
});

test("buildGeminiVideoFileName sanitizes names and appends .mp4", () => {
  assert.equal(buildGeminiVideoFileName("", 42), "gemini_video_42.mp4");
  assert.equal(buildGeminiVideoFileName("01 exterior dusk", 42), "01_exterior_dusk.mp4");
  assert.equal(buildGeminiVideoFileName("clip.MP4", 42), "clip.MP4");
  assert.equal(buildGeminiVideoFileName("///", 42), "gemini_video_42.mp4");
});

test("pickGeminiVideoSource returns the first http source with its duration", () => {
  assert.equal(pickGeminiVideoSource([]), null);
  assert.equal(pickGeminiVideoSource([{ src: "blob:https://gemini.google.com/x" }]), null);
  assert.deepEqual(pickGeminiVideoSource([{ src: "" }, { src: CLIP_URL, duration: 10.005 }]), {
    src: CLIP_URL,
    duration: 10.005,
  });
  assert.deepEqual(pickGeminiVideoSource([{ src: CLIP_URL, duration: Number.NaN }]), {
    src: CLIP_URL,
    duration: null,
  });
});

test("geminiVideoStatusText prefers the model turn over the body tail", () => {
  assert.equal(
    geminiVideoStatusText({
      responseText: "Gemini said\n\nYour  video is ready!",
      bodyTail: "x",
    }),
    "Gemini said Your video is ready!",
  );
  assert.equal(geminiVideoStatusText({ bodyTail: " tail " }), "tail");
  // The page reader always supplies responseText, empty before a turn renders.
  assert.equal(geminiVideoStatusText({ responseText: "  \n", bodyTail: " tail " }), "tail");
});

test("classifyGeminiVideoState reads page-level failures before a model turn renders", () => {
  const state = classifyGeminiVideoState({
    videos: [],
    responseText: "",
    bodyTail: "Videos\nSomething went wrong. Please try again.\nGemini can make mistakes",
  });
  assert.equal(state.status, "error");
  assert.match(state.message, /Something went wrong/);
  assert.equal(
    classifyGeminiVideoState({ videos: [], responseText: "", bodyTail: "Gemini can make mistakes" })
      .status,
    "pending",
  );
  // Generic wording counts only inside Gemini's reply, not in the page chrome.
  assert.equal(
    classifyGeminiVideoState({
      videos: [],
      responseText: "",
      bodyTail: "Some tools are not available in your region",
    }).status,
    "pending",
  );
  assert.equal(
    classifyGeminiVideoState({
      videos: [],
      responseText: "Video generation is not available for this prompt.",
    }).status,
    "error",
  );
});

test("classifyGeminiVideoState reads a page-level failure while the reply shows progress", () => {
  const state = classifyGeminiVideoState({
    videos: [],
    responseText: "Generating your video… This could take a few minutes.",
    bodyTail: "Generating your video… Something went wrong. Please try again.",
  });
  assert.equal(state.status, "error");
  assert.match(state.message, /Something went wrong/);
  assert.equal(
    classifyGeminiVideoState({
      videos: [],
      responseText: "Generating your video… This could take a few minutes.",
      bodyTail: "Generating your video… Gemini can make mistakes",
    }).status,
    "generating",
  );
});

test("geminiVideoPhaseBudgets splits the remaining --timeout budget", () => {
  assert.deepEqual(geminiVideoPhaseBudgets(560), { generationSeconds: 470, downloadSeconds: 90 });
  assert.deepEqual(geminiVideoPhaseBudgets(560, { skipDownload: true }).generationSeconds, 560);
  // The download fits inside its share, leaving OpenCLI's 30 s padding for
  // teardown.
  const tight = geminiVideoPhaseBudgets(100);
  assert.equal(tight.generationSeconds, 50);
  assert.equal(tight.downloadSeconds, 50);
  assert.equal(geminiVideoPhaseBudgets(-5).generationSeconds, 1);
});

test("geminiVideoSubmissionError requires a cleared editor and a conversation URL", () => {
  const conversation = "https://gemini.google.com/app/6f1c2b9a0d3e4f57";
  assert.equal(geminiVideoSubmissionError({ editorText: "", url: conversation }), null);
  assert.equal(
    geminiVideoSubmissionError({ editorText: "", url: "https://gemini.google.com/u/1/app/abc123" }),
    null,
  );
  assert.match(
    geminiVideoSubmissionError({ editorText: "a paper boat", url: conversation }),
    /composer still holds it/,
  );
  // Editor cleared but Gemini stayed on /videos: the prompt was dropped.
  assert.match(
    geminiVideoSubmissionError({ editorText: "", url: "https://gemini.google.com/videos" }),
    /did not open a conversation/,
  );
  assert.equal(isGeminiConversationUrl("https://gemini.google.com/app"), false);
  assert.equal(isGeminiConversationUrl(undefined), false);
});

test("classifyGeminiVideoState reports ready when a clip has rendered", () => {
  const state = classifyGeminiVideoState({
    videos: [{ src: CLIP_URL, duration: 10 }],
    responseText: "I'm generating your video. This could take a few minutes.",
  });
  assert.equal(state.status, "ready");
  assert.equal(state.source.src, CLIP_URL);
});

test("classifyGeminiVideoState reports generating and pending phases", () => {
  assert.equal(
    classifyGeminiVideoState({
      videos: [],
      responseText: "Generating your video… This could take a few minutes.",
    }).status,
    "generating",
  );
  assert.equal(classifyGeminiVideoState({ videos: [], responseText: "" }).status, "pending");
});

test("classifyGeminiVideoState surfaces Gemini failure copy", () => {
  const state = classifyGeminiVideoState({
    videos: [],
    responseText:
      "Gemini said I couldn't generate that video because it may violate our policies. Try a different prompt.",
  });
  assert.equal(state.status, "error");
  assert.match(state.message, /couldn't generate that video/);
  assert.equal(
    classifyGeminiVideoState({
      videos: [],
      responseText: "You've reached your daily limit.",
    }).status,
    "error",
  );
});

test("buildGeminiVideoCookieHeader forwards only cookies scoped to the host", () => {
  const cookies = [
    { name: "SID", value: "a", domain: ".google.com" },
    { name: "_ga", value: "b", domain: ".gemini.google.com" },
    { name: "bad", domain: ".google.com" },
    { name: "x", value: "c", domain: "example.com" },
  ];
  assert.equal(buildGeminiVideoCookieHeader(cookies, CLIP_URL), "SID=a");
  assert.equal(buildGeminiVideoCookieHeader(cookies, "not a url"), "");
  assert.equal(buildGeminiVideoCookieHeader(null, CLIP_URL), "");
});

test("isVideoContentType accepts video and binary responses only", () => {
  assert.equal(isVideoContentType("video/mp4"), true);
  assert.equal(isVideoContentType("application/octet-stream"), true);
  assert.equal(isVideoContentType("text/html; charset=utf-8"), false);
  assert.equal(isVideoContentType(""), false);
});

test("formatters render durations and sizes", () => {
  assert.equal(formatDuration(10.005), "10.0s");
  assert.equal(formatDuration(Number.NaN), "");
  assert.equal(formatBytes(4661590), "4.45 MB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(0), "0 B");
});

test("summarizeGeminiVideoResult builds the output row", () => {
  const home = os.homedir();
  const row = summarizeGeminiVideoResult({
    status: "saved",
    file: path.join(home, "tmp", "clip.mp4"),
    bytes: 4661590,
    duration: 10,
    link: "https://gemini.google.com/app/abc",
    images: ["/x/a.jpg"],
  });
  assert.deepEqual(row, {
    status: "saved",
    file: "~/tmp/clip.mp4",
    size: "4.45 MB",
    duration: "10.0s",
    images: 1,
    link: "https://gemini.google.com/app/abc",
  });
  assert.equal(summarizeGeminiVideoResult({ status: "generated" }).file, "-");
});
