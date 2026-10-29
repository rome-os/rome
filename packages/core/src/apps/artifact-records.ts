import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "./types.js";
import {
  claimLegacyArtifactNames,
  formatArtifactId,
  type ArtifactId,
  type ArtifactIdentityContext,
  type NamespacedArtifactKind,
} from "./artifact-id.js";
import { createLogger } from "../logger.js";

const log = createLogger("artifact-records");

export interface ArtifactRecord<T> {
  config: T;
  metadata: ArtifactMetadata;
}

/**
 * Reads each source and keys it by its artifact id, in source order. Core and
 * version-1 app sources claim their bare names in `identity.legacyBindings`.
 * A core source that fails to read, repeats an id, or collides with a legacy
 * binding throws. An app source that fails to read or repeats an id is skipped
 * and reported in `failures`, so one broken app cannot block the rest. A
 * version-1 app source whose bare name another artifact holds still loads
 * under its canonical id. It claims only the free names, and the holder keeps
 * the rest.
 */
export async function loadArtifactRecords<T extends { name: string }>(input: {
  kind: NamespacedArtifactKind;
  sources: readonly ArtifactMetadata[];
  identity: ArtifactIdentityContext;
  read: (metadata: ArtifactMetadata) => Promise<T>;
}): Promise<{
  records: Map<ArtifactId, ArtifactRecord<T>>;
  failures: AppOwnedArtifactLoadFailure[];
}> {
  const records = new Map<ArtifactId, ArtifactRecord<T>>();
  const failures: AppOwnedArtifactLoadFailure[] = [];
  const fail = (metadata: ArtifactMetadata, err: unknown) => {
    if (metadata.ownerType !== "app") throw err;
    failures.push({
      kind: metadata.kind,
      ownerId: metadata.ownerId,
      publicName: metadata.publicName,
      sourcePath: metadata.sourcePath,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  for (const metadata of input.sources) {
    let config: T;
    let artifactId: ArtifactId;
    try {
      config = await input.read(metadata);
      artifactId = formatArtifactId(metadata.ownerId, config.name);
    } catch (err) {
      fail(metadata, err);
      continue;
    }

    if (records.has(artifactId)) {
      fail(
        metadata,
        new Error(`Duplicate ${input.kind} name "${config.name}" found in ${metadata.sourcePath}`),
      );
      continue;
    }

    if (metadata.ownerType === "core" || metadata.formatVersion !== 2) {
      const claim = claimLegacyArtifactNames(
        input.identity.legacyBindings,
        input.kind,
        [config.name, metadata.publicName, ...metadata.aliases],
        artifactId,
      );
      if (claim.conflicts.length > 0 && metadata.ownerType === "core") {
        const conflicts = claim.conflicts
          .map(
            ({ legacyName, artifactId: owner }) =>
              `${JSON.stringify(legacyName)} is bound to ${owner}`,
          )
          .join(", ");
        throw new Error(`Legacy ${input.kind} name conflict: ${conflicts}`);
      }
      for (const { legacyName, artifactId: heldBy } of claim.conflicts) {
        log.info("legacy bare name kept by its current holder", {
          kind: input.kind,
          artifactId,
          legacyName,
          heldBy,
        });
      }
    }

    records.set(artifactId, { config, metadata });
  }

  return { records, failures };
}
