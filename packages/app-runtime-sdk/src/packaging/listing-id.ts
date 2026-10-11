/**
 * Core App Store listing-id grammar. Keep in sync with
 * packages/web/src/lib/app-listing-id.ts.
 *
 * A listing id names a listing in the Rome Cloud App Store. Two shapes:
 *
 *   Scoped:   `@<handle>/<slug>` — `handle` owns a publisher namespace,
 *             `slug` names a listing inside it.
 *   Unscoped: `<name>` — the name is its own listing in an independent
 *             namespace. Claiming the unscoped name grants no rights over
 *             `@<name>/*`, and vice versa.
 *
 * Syntax:
 *   handle — lowercase alphanumeric + hyphen, 2–32 chars, no leading or
 *            trailing hyphen (mirrors Rome Cloud user-slug rules).
 *   slug   — lowercase alphanumeric + hyphen + underscore, 2–64 chars, no
 *            leading or trailing hyphen/underscore.
 *   An unscoped name must satisfy the *handle* grammar (it occupies a
 *   handle row in Rome Cloud's namespace tables).
 *   `@x/x` (slug equal to handle) is forbidden — that listing is only
 *   addressable in its unscoped form, keeping URL ↔ id mappings unambiguous.
 *
 * Semantics relevant to core: the canonical listing id is also the installed
 * app id. In particular, `@alice/notes` stays `@alice/notes`; it must never
 * collapse to the non-unique slug `notes`.
 *
 * MIRROR: Rome Cloud owns the authoritative copy of these rules server-side in
 * the Rome Cloud store implementation. Rome Cloud deploys independently
 * and shares no workspace packages with core, so the grammar is mirrored
 * here rather than imported — any grammar change must update all copies.
 */

export const LISTING_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
export const LISTING_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

export type ParsedListingId =
  | { scoped: true; handle: string; slug: string; id: string }
  | { scoped: false; handle: string; slug: ""; id: string };

/**
 * Parse a logical listing id. Returns `null` for anything that is not
 * exactly an unscoped name or a scoped `@handle/slug` under the grammar
 * above — there is no lenient mode; callers that accept legacy URL forms
 * must extract the candidate id first (see `normalizeListingId` in
 * rome-cloud-urls.ts).
 */
export function parseListingId(id: string): ParsedListingId | null {
  if (id.startsWith("@")) {
    const slashIdx = id.indexOf("/");
    if (slashIdx < 0) return null;
    const handle = id.slice(1, slashIdx);
    const slug = id.slice(slashIdx + 1);
    if (!LISTING_HANDLE_PATTERN.test(handle)) return null;
    if (!LISTING_SLUG_PATTERN.test(slug)) return null;
    if (handle === slug) return null;
    return { scoped: true, handle, slug, id: `@${handle}/${slug}` };
  }
  if (!LISTING_HANDLE_PATTERN.test(id)) return null;
  return { scoped: false, handle: id, slug: "", id };
}
