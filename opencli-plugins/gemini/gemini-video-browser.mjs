import * as fs from "node:fs";
import * as path from "node:path";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import {
  buildGeminiVideoCookieHeader,
  classifyGeminiVideoState,
  GEMINI_VIDEO_URL,
  isVideoContentType,
} from "./gemini-video-helpers.mjs";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/**
 * Runs inside the Gemini page, so it must stay self-contained: `page.evaluate`
 * serializes the function source and cannot carry module-scope bindings along.
 *
 * Describes the video composer: whether the prompt editor and the Videos tool
 * chip are present, which aspect ratio is active, where the upload button sits
 * (a trusted pointer click there opens the file chooser), and how many image
 * attachments the composer currently shows.
 */
export function readGeminiVideoComposer() {
  var editor = document.querySelector(
    '[contenteditable="true"][aria-label="Enter a prompt for Gemini"], div.ql-editor[contenteditable="true"]',
  );
  // Once the daily video allowance is spent Gemini keeps the composer on
  // screen but locks it: the editor turns contenteditable="false" and its
  // container gains ql-disabled, with no message anywhere on the page.
  var lockedEditor = document.querySelector(
    'div.ql-editor[contenteditable="false"][aria-label="Enter a prompt for Gemini"]',
  );
  var editorLocked =
    !editor &&
    !!lockedEditor &&
    !!(lockedEditor.closest("rich-textarea") || lockedEditor.parentElement) &&
    String(
      (lockedEditor.closest("rich-textarea") || lockedEditor.parentElement).className || "",
    ).indexOf("ql-disabled") !== -1;
  var upload = document.querySelector('button[aria-label="File upload"]');
  var ratio = document.querySelector('button[aria-label^="Aspect ratio"]');
  var send = document.querySelector('button[aria-label="Send message"]');
  var uploadPoint = null;
  if (upload) {
    var rect = upload.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      uploadPoint = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }
  }
  // Each attachment renders as a tile that keeps a progress spinner until the
  // bytes reach Gemini; sending before that drops the message.
  var tiles = document.querySelectorAll("gem-media-attachment");
  var attachments = tiles.length;
  var uploading = 0;
  for (var i = 0; i < tiles.length; i++) {
    if (tiles[i].querySelector('[role="progressbar"], .gem-attachment-content.loading')) {
      uploading++;
    }
  }
  if (attachments === 0) {
    var images = document.querySelectorAll("img");
    for (var j = 0; j < images.length; j++) {
      var src = String(images[j].getAttribute("src") || "");
      if (src.indexOf("blob:") === 0) attachments++;
    }
  }
  return {
    url: location.href,
    hasEditor: !!editor,
    editorLocked: editorLocked,
    editorText: editor ? String(editor.innerText || "").trim() : "",
    videosToolSelected: !!document.querySelector('button[aria-label="Deselect Videos"]'),
    ratioLabel: ratio ? String(ratio.innerText || "").trim() : "",
    uploadPoint: uploadPoint,
    attachments: attachments,
    uploading: uploading,
    sendEnabled: !!send && !send.disabled,
  };
}

/** Self-contained for `page.evaluate`: the state of the newest model turn. */
export function readGeminiVideoTurn() {
  var responses = document.querySelectorAll("model-response");
  var last = responses.length ? responses[responses.length - 1] : null;
  var videos = [];
  var players = document.querySelectorAll("video");
  for (var i = 0; i < players.length; i++) {
    videos.push({
      src: String(players[i].currentSrc || players[i].getAttribute("src") || ""),
      duration: players[i].duration,
    });
  }
  var body = String((document.body && document.body.innerText) || "");
  return {
    url: location.href,
    videos: videos,
    responseText: last ? String(last.innerText || "") : "",
    bodyTail: body.slice(-600),
  };
}

function scriptClickRatioMenuItem(label) {
  return `(() => {
    const items = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const wanted = ${JSON.stringify(label)};
    const item = items.find((el) => (el.innerText || el.getAttribute('aria-label') || '').trim() === wanted);
    if (!item) return items.map((el) => (el.innerText || '').trim()).filter(Boolean);
    item.click();
    return true;
  })()`;
}

const SCRIPT_OPEN_RATIO_MENU = `(() => {
  const btn = document.querySelector('button[aria-label^="Aspect ratio"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const SCRIPT_FOCUS_EDITOR = `(() => {
  const editor = document.querySelector('[contenteditable="true"][aria-label="Enter a prompt for Gemini"], div.ql-editor[contenteditable="true"]');
  if (!editor) return false;
  editor.focus();
  return true;
})()`;

const SCRIPT_CLICK_SEND = `(() => {
  const btn = document.querySelector('button[aria-label="Send message"]');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
})()`;

async function pollComposer(page, predicate, { timeoutMs = 15000, intervalSeconds = 0.5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  for (;;) {
    state = await page.evaluate(readGeminiVideoComposer);
    if (predicate(state) || Date.now() >= deadline) return state;
    await page.wait(intervalSeconds);
  }
}

/**
 * Open the video composer. Gemini pre-selects its Videos tool on `/videos`, so
 * the page itself carries the mode instead of a menu click that can drift.
 */
export async function openGeminiVideoComposer(page) {
  await page.goto(GEMINI_VIDEO_URL, { waitUntil: "load", settleMs: 2500 });
  const state = await pollComposer(
    page,
    (s) => (s.hasEditor && s.videosToolSelected) || s.editorLocked,
    { timeoutMs: 20000 },
  );
  if (state.editorLocked) {
    throw new CommandExecutionError(
      "Gemini has locked its video composer for this account, which is how it shows a spent daily video allowance (Google AI Pro: 3 videos a day); retry after the daily reset",
    );
  }
  if (!state.hasEditor) {
    throw new CommandExecutionError(
      "Gemini video composer did not load; sign in at https://gemini.google.com and retry",
    );
  }
  if (!state.videosToolSelected) {
    throw new CommandExecutionError(
      "Gemini did not select its Videos tool on /videos; video generation may be unavailable for this account",
    );
  }
  return state;
}

export async function selectGeminiVideoRatio(page, label) {
  const current = await page.evaluate(readGeminiVideoComposer);
  if (current.ratioLabel === label) return label;
  const opened = await page.evaluate(SCRIPT_OPEN_RATIO_MENU);
  if (!opened) throw new CommandExecutionError("Gemini aspect ratio control was not found");
  await page.wait(0.7);
  const picked = await page.evaluate(scriptClickRatioMenuItem(label));
  if (picked !== true) {
    const seen =
      Array.isArray(picked) && picked.length ? ` (menu shows: ${picked.join(", ")})` : "";
    throw new CommandExecutionError(`Gemini aspect ratio "${label}" was not offered${seen}`);
  }
  const state = await pollComposer(page, (s) => s.ratioLabel === label, {
    timeoutMs: 5000,
  });
  if (state.ratioLabel !== label) {
    throw new CommandExecutionError(
      `Gemini kept aspect ratio "${state.ratioLabel}" after selecting "${label}"`,
    );
  }
  return label;
}

/**
 * Attach reference images. Gemini builds its file input on demand, so the flow
 * intercepts the file chooser the upload button opens and hands Chrome the local
 * paths for that node. Only a trusted pointer click opens the chooser, and the
 * interception needs CDP events, which the direct `--cdp-endpoint` backend
 * exposes as `page.bridge`.
 */
export async function attachGeminiVideoImages(page, files) {
  if (!files.length) return 0;
  const bridge = page.bridge;
  if (typeof page.cdp !== "function" || !bridge || typeof bridge.waitForEvent !== "function") {
    throw new CommandExecutionError(
      "Image upload needs the direct CDP backend; rerun with --cdp-endpoint http://127.0.0.1:9222",
    );
  }
  const before = await page.evaluate(readGeminiVideoComposer);
  if (!before.uploadPoint) {
    throw new CommandExecutionError("Gemini video composer has no visible File upload button");
  }
  await page.cdp("Page.enable", {}).catch(() => undefined);
  await page.cdp("DOM.enable", {}).catch(() => undefined);
  await page.cdp("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const chooser = bridge.waitForEvent("Page.fileChooserOpened", 15000);
    await page.nativeClick(before.uploadPoint.x, before.uploadPoint.y);
    let opened;
    try {
      opened = await chooser;
    } catch {
      throw new CommandExecutionError(
        "Gemini did not open a file chooser for the File upload button",
      );
    }
    await page.cdp("DOM.setFileInputFiles", {
      files,
      backendNodeId: opened.backendNodeId,
    });
  } finally {
    await page.cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }
  const wanted = before.attachments + files.length;
  const state = await pollComposer(page, (s) => s.attachments >= wanted && s.uploading === 0, {
    timeoutMs: 90000,
  });
  if (state.attachments < wanted) {
    throw new CommandExecutionError(
      `Gemini shows ${state.attachments - before.attachments} of ${files.length} uploaded images; retry with fewer or smaller files`,
    );
  }
  if (state.uploading > 0) {
    throw new CommandExecutionError(
      `Gemini is still uploading ${state.uploading} of ${files.length} images after 90s; retry with smaller files`,
    );
  }
  // Let the composer settle before typing so the focus stays in the editor.
  await page.wait({ time: 0.5 });
  return files.length;
}

export async function submitGeminiVideoPrompt(page, prompt) {
  const focused = await page.evaluate(SCRIPT_FOCUS_EDITOR);
  if (!focused) throw new CommandExecutionError("Gemini prompt editor was not found");
  await page.nativeType(prompt);
  const typed = await pollComposer(page, (s) => s.editorText.length > 0 && s.sendEnabled, {
    timeoutMs: 5000,
  });
  if (!typed.editorText) throw new CommandExecutionError("Failed to insert the prompt into Gemini");
  if (!typed.sendEnabled) throw new CommandExecutionError("Gemini send button stayed disabled");
  const sent = await page.evaluate(SCRIPT_CLICK_SEND);
  if (!sent) throw new CommandExecutionError("Gemini send button could not be clicked");
  // A accepted submission clears the editor and opens a conversation URL; a
  // dropped one leaves the prompt in place, which must fail fast instead of
  // waiting the whole generation timeout for a clip that never comes.
  const after = await pollComposer(
    page,
    (s) => s.editorText.length === 0 && /\/app\/[a-z0-9]+/i.test(s.url),
    { timeoutMs: 30000 },
  );
  if (after.editorText.length > 0) {
    throw new CommandExecutionError(
      "Gemini did not accept the prompt; the composer still holds it",
    );
  }
}

/**
 * Poll the newest model turn until a clip renders, Gemini reports a failure, or
 * the deadline passes. Generation takes one to several minutes.
 */
export async function waitForGeminiVideo(page, timeoutSeconds, { intervalSeconds = 5 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = { status: "pending" };
  for (;;) {
    let snapshot = await page.evaluate(readGeminiVideoTurn);
    last = classifyGeminiVideoState(snapshot);
    if (last.status === "ready" && last.source.duration === null) {
      // The player reports its length once metadata arrives, shortly after mount.
      await page.wait({ time: 2 });
      snapshot = await page.evaluate(readGeminiVideoTurn);
      last = classifyGeminiVideoState(snapshot);
    }
    if (last.status === "ready") return { ...last.source, link: snapshot.url };
    if (last.status === "error") {
      throw new CommandExecutionError(`Gemini did not generate the video: ${last.message}`);
    }
    if (Date.now() >= deadline) return null;
    await page.wait(Math.min(intervalSeconds, Math.max(0.5, (deadline - Date.now()) / 1000)));
  }
}

/** Download the clip with the browser session's cookies; Gemini's media host refuses anonymous requests. */
export async function downloadGeminiVideo(page, src, filePath, { fetchImpl = fetch } = {}) {
  const cookies = await page.getCookies({ url: src });
  const cookie = buildGeminiVideoCookieHeader(cookies, src);
  const response = await fetchImpl(src, {
    redirect: "follow",
    headers: {
      ...(cookie ? { cookie } : {}),
      "user-agent": BROWSER_USER_AGENT,
      referer: "https://gemini.google.com/",
    },
  });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !isVideoContentType(type)) {
    throw new CommandExecutionError(
      `Gemini video download returned ${response.status} ${type || "unknown type"}; open the conversation and download it manually`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return bytes.length;
}
