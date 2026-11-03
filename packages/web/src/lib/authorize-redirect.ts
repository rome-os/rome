export type AuthorizeRedirectResult = { ok: true } | { ok: false; reason: "start" | "network" };

/** POSTs to a core route that answers `{ authorizeUrl }`, then navigates the
 *  browser there. On success the browser leaves the SPA, so a caller acts only
 *  on `ok: false`: `start` when core refuses or sends no URL, `network` when
 *  the request throws. */
export async function beginAuthorizeRedirect(
  url: string,
  body?: Record<string, unknown>,
): Promise<AuthorizeRedirectResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      ...(body && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const data = (await res.json().catch(() => null)) as { authorizeUrl?: string } | null;
    if (!res.ok || !data?.authorizeUrl) return { ok: false, reason: "start" };
    window.location.href = data.authorizeUrl;
    return { ok: true };
  } catch {
    return { ok: false, reason: "network" };
  }
}
