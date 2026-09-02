import * as path from "node:path";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  attachGeminiVideoImages,
  downloadGeminiVideo,
  openGeminiVideoComposer,
  selectGeminiVideoRatio,
  submitGeminiVideoPrompt,
  waitForGeminiVideo,
} from "./gemini-video-browser.mjs";
import {
  buildGeminiVideoFileName,
  GEMINI_VIDEO_DEFAULT_OUTPUT,
  GEMINI_VIDEO_RATIOS,
  geminiVideoRatioLabel,
  integerInRange,
  parseGeminiVideoImages,
  resolveGeminiVideoOutputDir,
  summarizeGeminiVideoResult,
} from "./gemini-video-helpers.mjs";

cli({
  site: "gemini",
  name: "video",
  access: "write",
  description:
    "Generate a video with Gemini web, optionally animating uploaded reference images, and save it locally",
  example:
    'opencli --cdp-endpoint http://127.0.0.1:9222 gemini video "Slow cinematic dolly toward the house at dusk" --image ./front.jpg --output ./clips --name front-dusk',
  domain: "gemini.google.com",
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  defaultFormat: "plain",
  args: [
    {
      name: "prompt",
      type: "string",
      positional: true,
      required: true,
      help: "Describe the video; with --image, describe how the photo should move",
    },
    {
      name: "image",
      type: "string",
      default: "",
      help: "Comma-separated local image paths to attach as reference or start frames (needs --cdp-endpoint)",
    },
    {
      name: "ratio",
      type: "string",
      default: "16:9",
      choices: GEMINI_VIDEO_RATIOS,
      help: "Aspect ratio: 16:9 (landscape) or 9:16 (portrait)",
    },
    {
      name: "output",
      type: "string",
      default: GEMINI_VIDEO_DEFAULT_OUTPUT,
      help: "Directory that receives the saved clip",
    },
    {
      name: "name",
      type: "string",
      default: "",
      help: "File name for the clip (default: gemini_video_<timestamp>.mp4)",
    },
    {
      name: "timeout",
      type: "int",
      default: 600,
      help: "Max seconds to wait for the generation (default: 600)",
    },
    {
      name: "sd",
      type: "boolean",
      default: false,
      help: "Skip the download; only report the conversation link",
    },
  ],
  columns: ["status", "file", "size", "duration", "images", "link"],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError("Browser session required for gemini video");
    let images;
    let ratioLabel;
    let timeout;
    let outputDir;
    const prompt = String(kwargs.prompt ?? "").trim();
    try {
      if (!prompt) throw new Error("prompt must not be empty");
      images = parseGeminiVideoImages(kwargs.image);
      ratioLabel = geminiVideoRatioLabel(kwargs.ratio ?? "16:9");
      timeout = integerInRange(kwargs.timeout ?? 600, "timeout", 30, 3600);
      outputDir = resolveGeminiVideoOutputDir(kwargs.output);
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }

    await openGeminiVideoComposer(page);
    await selectGeminiVideoRatio(page, ratioLabel);
    await attachGeminiVideoImages(page, images);
    await submitGeminiVideoPrompt(page, prompt);

    const video = await waitForGeminiVideo(page, timeout);
    if (!video) {
      const link = await page.evaluate("window.location.href").catch(() => "");
      throw new CommandExecutionError(
        `No video appeared within ${timeout}s; Gemini may still be generating at ${link || "https://gemini.google.com/app"}`,
      );
    }
    if (kwargs.sd === true) {
      return [
        summarizeGeminiVideoResult({
          status: "generated",
          duration: video.duration,
          link: video.link,
          images,
        }),
      ];
    }
    const file = path.join(outputDir, buildGeminiVideoFileName(kwargs.name));
    const bytes = await downloadGeminiVideo(page, video.src, file);
    return [
      summarizeGeminiVideoResult({
        status: "saved",
        file,
        bytes,
        duration: video.duration,
        link: video.link,
        images,
      }),
    ];
  },
});
