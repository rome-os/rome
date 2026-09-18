// A cloud sign-in completes setup on the server, which cannot know the
// guardian's timezone. The SPA reports the browser's zone once per page load,
// and the server adopts it only while no zone is stored (see
// `POST /api/settings/guardian-timezone/detected`), so a zone the guardian
// chose in Settings is never overwritten.

let reported = false;

export function detectBrowserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Post the browser timezone once per page load. Safe to call from every
 *  render that sees a signed-in guardian; later calls are no-ops. A failed
 *  post is not retried. */
export async function reportDetectedTimezoneOnce(fetcher: typeof fetch = fetch): Promise<void> {
  if (reported) return;
  reported = true;
  const timezone = detectBrowserTimezone();
  if (!timezone) return;
  try {
    await fetcher("/api/settings/guardian-timezone/detected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ timezone }),
    });
  } catch {
    // Scheduling falls back to the host zone until the guardian sets one.
  }
}

/** Test seam: forget that the zone was reported. */
export function resetDetectedTimezoneReport(): void {
  reported = false;
}
