// A grant made before the Slack gateway Worker holds Slack's bot token on the
// instance. Disconnecting it revokes that token at Slack, the one call the
// instance still makes to Slack itself; every other call goes through the
// Worker (rome-cloud docs/slack-gateway.md).

const AUTH_REVOKE = "https://slack.com/api/auth.revoke";

/** The bot token a grant from before the Worker holds, or null. */
export function legacyBotToken(material: unknown): string | null {
  const token = (material as { botToken?: unknown } | null)?.botToken;
  return typeof token === "string" && token ? token : null;
}

/** Revokes a bot token at Slack. Answers null once Slack revoked it or
 *  already refuses it, else why it did not; the reason never holds the token. */
export async function revokeLegacyBotToken(
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(AUTH_REVOKE, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (body?.ok) return null;
    const code = body?.error ?? `http_${res.status}`;
    // A token Slack already refuses can no longer be used.
    if (["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(code)) {
      return null;
    }
    return code;
  } catch (error) {
    return error instanceof Error ? error.name : "network_error";
  }
}
