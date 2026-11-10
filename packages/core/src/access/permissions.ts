/** Who asks to open something: the guardian, a signed-in visitor, or someone not signed in. */
export type Principal =
  | { kind: "guardian" }
  | { kind: "visitor"; email: string }
  | { kind: "anonymous" };

/**
 * Who besides the guardian may open one thing. Anyone with the link wins over
 * the listed emails, and the list is kept while the link is on so turning it
 * off brings the list back. With neither, only the guardian may open it.
 */
export interface Permission {
  anyoneWithLink: boolean;
  /** Normalized visitor emails. */
  listedEmails: ReadonlySet<string>;
}

export const GUARDIAN_ONLY: Permission = { anyoneWithLink: false, listedEmails: new Set() };

/**
 * `guardian-only` leaves the answer to the guardian's own session, and to
 * whatever else lets a principal in, such as the dashboard allow-list.
 */
export type Verdict = "allowed" | "sign-in-required" | "forbidden" | "guardian-only";

/** Whether `principal` may open a thing under `permission`. */
export function decide(permission: Permission, principal: Principal): Verdict {
  if (permission.anyoneWithLink) return "allowed";
  if (principal.kind === "guardian") return "allowed";
  if (permission.listedEmails.size === 0) return "guardian-only";
  if (principal.kind === "anonymous") return "sign-in-required";
  return permission.listedEmails.has(principal.email.toLowerCase()) ? "allowed" : "forbidden";
}

/**
 * The permission of each thing, by an id Access does not interpret, kept in
 * memory for `/api/auth/verify`.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request, so
 * the probe can't afford a DB round-trip. Whoever stores the permissions sets
 * them here at startup and after each write.
 */
export class Permissions {
  private byId: ReadonlyMap<string, Permission> = new Map();

  get(id: string): Permission {
    return this.byId.get(id) ?? GUARDIAN_ONLY;
  }

  replace(byId: ReadonlyMap<string, Permission>): void {
    this.byId = new Map(byId);
  }
}
