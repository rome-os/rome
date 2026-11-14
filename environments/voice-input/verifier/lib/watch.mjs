// What the page does that the guardian cannot see in the field: the microphone's capture tracks,
// and every notice its `role="status"` elements show. Both are read in the page's own clock.

/**
 * Runs in the page before its own code, on every load. Records each audio track
 * `getUserMedia` hands the page and when it ends, and each text a `role="status"` element shows.
 */
function watcher() {
  if (window.__watch) return;
  const watch = { tracks: [], notices: [] };
  window.__watch = watch;
  const devices = navigator.mediaDevices;
  if (devices?.getUserMedia) {
    const getUserMedia = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      for (const track of stream.getAudioTracks()) {
        const entry = { openedAt: performance.now(), endedAt: null, track };
        watch.tracks.push(entry);
        track.addEventListener("ended", () => {
          entry.endedAt ??= performance.now();
        });
      }
      return stream;
    };
  }
  const stop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    for (const entry of watch.tracks)
      if (entry.track === this && this.readyState === "live") entry.endedAt = performance.now();
    return stop.call(this);
  };
  let last = null;
  const read = () => {
    const text = [...document.querySelectorAll("[role=status]")]
      .map((el) => el.textContent.trim())
      .filter(Boolean)
      .join(" | ");
    if (text !== last) {
      last = text;
      watch.notices.push([performance.now(), text]);
    }
  };
  new MutationObserver(read).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
}

/** Starts watching from the page's next load, and reloads it so the watch covers its code. */
export async function watchPage(page) {
  await page.addInitScript(watcher);
  await page.reload();
}

/** `{ open, tracks: [{ openedAt, endedAt }] }`: how many audio tracks are live now, and each one's times. */
export async function micState(page) {
  return page.evaluate(() => {
    const tracks = window.__watch?.tracks ?? [];
    return {
      open: tracks.filter((t) => t.track.readyState === "live").length,
      tracks: tracks.map(({ openedAt, endedAt }) => ({ openedAt, endedAt })),
    };
  });
}

/**
 * Waits until no audio track is live and resolves to the milliseconds from `since` (page clock)
 * to when the last one ended, or null when one is still live after `timeoutMs`.
 */
export async function waitForMicClosed(page, since, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  for (;;) {
    const { open, tracks } = await micState(page);
    if (open === 0) {
      const ended = tracks.map((t) => t.endedAt).filter((t) => t !== null);
      return ended.length === 0 ? 0 : Math.max(0, Math.max(...ended) - since);
    }
    if (Date.now() - start > timeoutMs) return null;
    await page.waitForTimeout(50);
  }
}

/** The notices shown at or after `since` (page clock), `[[ms, text]]`, oldest first. */
export async function noticesSince(page, since) {
  return (await notices(page)).filter(([t, text]) => t >= since && text);
}

/** Every notice the page showed, `[[ms, text]]`, oldest first; an empty text means none shown. */
export async function notices(page) {
  return page.evaluate(() => window.__watch?.notices ?? []);
}

/**
 * Waits for a notice in the form, and resolves to `{ text, ms }`, with `ms` from `since` in the
 * page clock, or null when none shows within `timeoutMs` of the call.
 */
export async function waitForNotice(page, form, since, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  for (;;) {
    const text = await form
      .locator("[role=status]")
      .allTextContents()
      .then((t) =>
        t
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" | "),
      )
      .catch(() => "");
    if (text) {
      const shown = (await notices(page)).find(([, t]) => t === text);
      const now = await page.evaluate(() => performance.now());
      return { text, ms: Math.max(0, (shown?.[0] ?? now) - since) };
    }
    if (Date.now() - start > timeoutMs) return null;
    await page.waitForTimeout(50);
  }
}
