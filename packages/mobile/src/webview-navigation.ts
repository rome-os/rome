// Native navigation for the instance WebView: hardware back and pull-to-refresh.
//
// Pull-to-refresh is detected inside the page instead of by the native scroll
// view. The dashboard sets `overscroll-behavior-y: none` on its root, which
// stops WKWebView's root scroll view from bouncing, so a UIRefreshControl
// cannot be pulled. Android's WebView has no refresh control at all, and a
// SwipeRefreshLayout around it only sees the root scroll position, so it would
// fire while an inner pane such as the chat transcript is scrolled down. The
// page knows which element is under the finger and whether it is at its top.

/** Distance in CSS pixels a pull travels before releasing it reloads the page. */
export const PULL_TO_REFRESH_THRESHOLD = 72;

/** Message type the injected script posts through `ReactNativeWebView`. */
export const PULL_TO_REFRESH_MESSAGE = "rome-mobile:pull";

export type PullToRefreshEvent =
  | { phase: "move"; distance: number }
  | { phase: "end"; distance: number }
  | { phase: "cancel" };

interface BackNavigableWebView {
  goBack(): void;
}

/**
 * Handles one Android hardware back press. Steps the WebView back and returns
 * true when its history has an earlier entry. Returns false otherwise, so the
 * press falls through to the system and leaves the app.
 */
export function handleHardwareBack(
  canGoBack: boolean,
  webView: BackNavigableWebView | null,
): boolean {
  if (!canGoBack || !webView) return false;
  webView.goBack();
  return true;
}

/** Returns the pull event a WebView message carries, or null for any other message. */
export function parsePullToRefreshMessage(data: string): PullToRefreshEvent | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, phase, distance } = message as Record<string, unknown>;
  if (type !== PULL_TO_REFRESH_MESSAGE) return null;
  if (phase === "cancel") return { phase };
  if ((phase === "move" || phase === "end") && typeof distance === "number") {
    if (!Number.isFinite(distance) || distance < 0) return null;
    return { phase, distance };
  }
  return null;
}

/** Longest a pull-triggered reload holds the spinner before the gesture unlocks. */
export const PULL_TO_REFRESH_RELOAD_TIMEOUT_MS = 15_000;

/** Native side of pull-to-refresh, driven by `PullToRefreshController`. */
export interface PullToRefreshView {
  /** Moves the indicator to follow the finger, without animation. */
  showPull(distance: number): void;
  /** Animates the indicator to a resting distance. */
  settle(distance: number): void;
  setReloading(reloading: boolean): void;
  thresholdReached(): void;
  reload(): void;
}

/**
 * Turns WebView pull messages and load events into indicator and reload calls.
 * While a reload is in flight it ignores pull messages. The reload ends at the
 * next `loadEnded`, a `reset`, or after PULL_TO_REFRESH_RELOAD_TIMEOUT_MS,
 * whichever comes first. Call `dispose` on unmount to drop the pending timeout.
 */
export class PullToRefreshController {
  #view: PullToRefreshView;
  #schedule: (run: () => void, ms: number) => () => void;
  #showing = false;
  #pastThreshold = false;
  #cancelTimeout: (() => void) | null = null;

  constructor(
    view: PullToRefreshView,
    schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  ) {
    this.#view = view;
    this.#schedule = schedule;
  }

  handle(event: PullToRefreshEvent): void {
    if (this.#cancelTimeout) return;
    if (event.phase === "move") {
      this.#showing = true;
      this.#view.showPull(event.distance);
      const pastThreshold = event.distance >= PULL_TO_REFRESH_THRESHOLD;
      if (pastThreshold && !this.#pastThreshold) this.#view.thresholdReached();
      this.#pastThreshold = pastThreshold;
      return;
    }
    if (event.phase === "end" && event.distance >= PULL_TO_REFRESH_THRESHOLD) {
      this.#pastThreshold = false;
      this.#cancelTimeout = this.#schedule(
        () => this.loadEnded(),
        PULL_TO_REFRESH_RELOAD_TIMEOUT_MS,
      );
      this.#view.setReloading(true);
      this.#view.settle(PULL_TO_REFRESH_THRESHOLD);
      this.#view.reload();
      return;
    }
    this.#clearPull();
  }

  /**
   * Call when a load starts. The document that reported a partial pull may be
   * gone and will never send its `end` or `cancel`, so the indicator retracts.
   * An in-flight reload keeps its spinner.
   */
  loadStarted(): void {
    if (!this.#cancelTimeout) this.#clearPull();
  }

  loadEnded(): void {
    if (!this.#cancelTimeout) return;
    this.#cancelTimeout();
    this.#cancelTimeout = null;
    this.#view.setReloading(false);
    this.#showing = true;
    this.#clearPull();
  }

  /** Call when the WebView remounts. Ends any reload and retracts any pull. */
  reset(): void {
    this.loadEnded();
    this.#clearPull();
  }

  dispose(): void {
    this.#cancelTimeout?.();
    this.#cancelTimeout = null;
  }

  #clearPull(): void {
    this.#pastThreshold = false;
    if (!this.#showing) return;
    this.#showing = false;
    this.#view.settle(0);
  }
}

/**
 * Page script for `injectedJavaScript`. It reads only `window`, so a test can
 * run it against a stand-in. It installs once per document.
 *
 * A pull starts only when one finger lands outside an editable field, no
 * overlay holds the scroll lock, and neither the document nor any ancestor of
 * the touched element is scrolled. It ends when the finger lifts, and cancels
 * when the finger moves up past the start, moves sideways first, a second
 * finger lands, or a page handler calls preventDefault on the move.
 */
export const PULL_TO_REFRESH_SCRIPT = `(function () {
  var w = window;
  if (w.__romeMobilePullToRefresh) return;
  w.__romeMobilePullToRefresh = true;
  var doc = w.document;
  var SLOP = 10;
  var start = null;
  var pulling = false;
  var lastDistance = -1;

  function post(message) {
    message.type = ${JSON.stringify(PULL_TO_REFRESH_MESSAGE)};
    if (w.ReactNativeWebView) w.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function editable(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
        return true;
      }
    }
    return false;
  }

  function atTop(node) {
    if (doc.body && doc.body.hasAttribute("data-scroll-locked")) return false;
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
    }
    var root = doc.scrollingElement || doc.documentElement;
    return !(root && root.scrollTop > 0) && !(w.scrollY > 0);
  }

  function reset() {
    start = null;
    pulling = false;
    lastDistance = -1;
  }

  function cancel() {
    if (pulling) post({ phase: "cancel" });
    reset();
  }

  w.addEventListener("touchstart", function (event) {
    cancel();
    if (event.touches.length !== 1) return;
    var target = event.target;
    if (editable(target) || !atTop(target)) return;
    var selection = w.getSelection ? String(w.getSelection()) : "";
    if (selection) return;
    var touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY, target: target };
  }, { capture: true, passive: true });

  w.addEventListener("touchmove", function (event) {
    if (!start) return;
    if (event.touches.length !== 1 || event.defaultPrevented) return cancel();
    var touch = event.touches[0];
    var dx = touch.clientX - start.x;
    var dy = touch.clientY - start.y;
    if (!pulling) {
      if (dy < 0 || (Math.abs(dx) > SLOP && Math.abs(dx) >= dy)) return cancel();
      if (dy <= SLOP) return;
      if (!atTop(start.target)) return cancel();
      pulling = true;
    }
    if (!atTop(start.target)) return cancel();
    var distance = Math.max(0, Math.round(dy - SLOP));
    if (distance === lastDistance) return;
    lastDistance = distance;
    post({ phase: "move", distance: distance });
  }, { passive: true });

  w.addEventListener("touchend", function () {
    if (pulling) post({ phase: "end", distance: Math.max(0, lastDistance) });
    reset();
  }, { capture: true, passive: true });

  w.addEventListener("touchcancel", cancel, { capture: true, passive: true });
})();
true;`;
