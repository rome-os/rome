const REPORT_INTERVAL_MS = 60_000;

/** Reports foreground usage without sending interaction content or polling idle tabs. */
export function startUserActivityReporting(): () => void {
  let lastAttempt = Number.NEGATIVE_INFINITY;
  const report = (event?: Event) => {
    if (event?.isTrusted === false) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const now = Date.now();
    if (now - lastAttempt < REPORT_INTERVAL_MS) return;
    lastAttempt = now;
    void fetch("/api/user-activity", {
      method: "POST",
      credentials: "include",
      headers: { "X-Rome-Activity": "1" },
      signal: AbortSignal.timeout(6_000),
    }).catch(() => {});
  };

  const events = ["pointerdown", "keydown", "wheel", "visibilitychange"] as const;
  for (const event of events) document.addEventListener(event, report, { passive: true });
  window.addEventListener("focus", report);
  report();

  return () => {
    for (const event of events) document.removeEventListener(event, report);
    window.removeEventListener("focus", report);
  };
}
