import type { ProveIdentityResult } from "./instance-identity.js";

/**
 * The guardian's Rome Cloud account exactly as whoami returns it: id, email,
 * avatar, Rome address, display name, sign-in links, preview survey and the
 * Signup Research report. Rome Cloud already sends research only when it
 * matched the guardian, so core passes the record through unchanged. Older
 * Rome Clouds send only id, email and avatar.
 */
export type CloudProfile = Record<string, unknown>;

export type CloudProfileOutcome =
  | { kind: "ok"; profile: CloudProfile }
  /** Not enrolled with Rome Cloud, unreachable, or the token was rejected. */
  | { kind: "unavailable"; reason: string };

export interface CloudProfileService {
  get(): Promise<CloudProfileOutcome>;
}

/** The whoami `account` field, or an empty profile when it is missing. */
export function readCloudProfile(account: unknown): CloudProfile {
  return account && typeof account === "object" && !Array.isArray(account)
    ? (account as CloudProfile)
    : {};
}

/** Main-process reader: the instance token never leaves main, so workers reach
 *  this through `CloudProfileProxy`. Unlike the heartbeat, a rejected token
 *  is only reported here; clearing it stays with the enrollment flow. */
export class CloudProfileClient implements CloudProfileService {
  constructor(private readonly prove: () => Promise<ProveIdentityResult>) {}

  async get(): Promise<CloudProfileOutcome> {
    const result = await this.prove();
    if (result.status !== "ok") return { kind: "unavailable", reason: result.status };
    return { kind: "ok", profile: result.identity.profile ?? readCloudProfile(null) };
  }
}
