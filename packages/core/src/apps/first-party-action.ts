import { isCanonicalArtifactId } from "./artifact-id.js";
import type { AppId, AppView, ArtifactRef, ResolvedApp } from "./state.js";

/** The slice of `AppCatalog` the first-party check reads. */
export interface FirstPartyCatalog {
  get(appId: AppId): AppView | ResolvedApp | null;
  findArtifact(kind: "action", name: string): ArtifactRef | null;
}

/**
 * Whether the named action belongs to core or to an app the lockfile marks
 * first-party. Trust comes from the install record, never from anything the
 * app's own manifest declares (an app can write `type: system` freely).
 *
 * Canonical ids (`<appId>:<local>`) carry their owner; any other name is
 * resolved through the catalog's public names and aliases.
 */
export function isFirstPartyAction(catalog: FirstPartyCatalog, actionName: string): boolean {
  let ownerType: ArtifactRef["ownerType"];
  let ownerId: string;
  if (isCanonicalArtifactId(actionName)) {
    ownerId = actionName.slice(0, actionName.indexOf(":"));
    ownerType = ownerId === "core" ? "core" : "app";
  } else {
    const ref = catalog.findArtifact("action", actionName);
    if (!ref) return false;
    ownerType = ref.ownerType;
    ownerId = ref.ownerId;
  }
  if (ownerType === "core") return true;
  return catalog.get(ownerId)?.firstParty === true;
}
