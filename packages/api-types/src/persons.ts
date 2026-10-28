// How a person's display name becomes the id that keys their row, their
// channel mappings, and their profile file on disk.
//
// The derivation is part of the contract rather than an implementation detail
// of the create route: the id is guardian-visible on the People page, and any
// client that predicts one — the dashboard's mock backend today — has to
// produce the same slug the server would. Keeping it here means the repository
// and that client read one function instead of two that agree until the first
// punctuation edge case.

/** Why a person row refuses a guardian's edit. */
export type ProtectedPersonReason = "guardian";

/**
 * Why this person refuses to be moved along the ladder or merged away, or null
 * when they accept both. The guardian anchors the ladder.
 *
 * Every write that reassigns or removes a person reads this — the route and the
 * dashboard's mock backend alike — so the two cannot disagree on who is off
 * limits. The caller phrases its own message from the reason.
 */
export function protectedPersonReason(person: { bondLevel: string }): ProtectedPersonReason | null {
  return person.bondLevel === "guardian" ? "guardian" : null;
}

/**
 * The slug for a display name: lower-cased, spaces to hyphens, everything
 * outside `[a-z0-9-]` dropped, runs of hyphens collapsed, no leading or
 * trailing hyphen.
 *
 * Returns the empty string when nothing survives — a name written entirely in
 * a non-Latin script does, so callers need their own fallback rather than
 * assuming a usable id comes back.
 */
export function generatePersonSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The id to mint for `base` given the ids already taken that could collide with
 * it — `base` itself, and anything of the form `base-<n>`. Returns `base` when
 * it is free, otherwise `base-<n>`.
 *
 * The suffix numbers the person among everyone sharing the name, and `base` is
 * the first of them: the second Ada Lovelace is `ada-lovelace-2`, the third
 * `ada-lovelace-3`. So the id a guardian reads on the People page counts the
 * way they would count, and no id claims to be the first of a name that
 * already has one.
 *
 * One past the highest suffix in use, not the first free slot: reusing the id
 * of a person who has been deleted would silently re-point their old profile
 * file and any channel mapping that outlived them at whoever is created next.
 *
 * Callers may pass ids that cannot collide; they are ignored. Passing only a
 * pre-filtered set is therefore an optimization, never a correctness condition.
 */
export function nextAvailablePersonId(base: string, taken: Iterable<string>): string {
  const takenIds = [...taken];
  if (!takenIds.includes(base)) return base;

  let suffix = 2;
  for (const id of takenIds) {
    if (!id.startsWith(`${base}-`)) continue;
    const num = Number.parseInt(id.slice(base.length + 1), 10);
    if (!Number.isNaN(num) && num >= suffix) suffix = num + 1;
  }
  return `${base}-${suffix}`;
}
