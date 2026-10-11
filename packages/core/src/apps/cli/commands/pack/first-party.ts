import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command, Flags } from "@oclif/core";
import { createLogger } from "../../../../logger.js";
import { getFirstPartyArtifactDir, getProjectRoot, getRepoAppsDir } from "../../../../paths.js";
import { packArtifact } from "@rome-os/app-runtime/packaging";

const log = createLogger("apps-cli");

export default class PackageFirstParty extends Command {
  static override description =
    "Pack every first-party app under rome_apps/ into dist/first-party-artifacts/<id>/ — the " +
    "set boot installs. Replaces a serial per-app `app:pack` loop: all packs run concurrently " +
    "in ONE process, so the build step pays the tsx/oclif startup cost once instead of per app " +
    "(13 serial packs ≈ 10s → one batch ≈ 0.6s). Daemon-independent build-step machinery.";

  static override examples = ["pnpm --filter @rome/core app:pack:first-party"];

  static override flags = {
    concurrency: Flags.integer({
      description: "Maximum number of apps to pack in parallel.",
      default: 8,
      min: 1,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PackageFirstParty);
    const projectRoot = getProjectRoot();
    const appsDir = getRepoAppsDir(projectRoot);

    // Every rome_apps/<id>/ that declares an app.yaml; apps without a build
    // script are packed from source.
    const entries = await readdir(appsDir, { withFileTypes: true });
    const appIds = entries
      .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, "app.yaml")))
      .map((entry) => entry.name)
      .sort();

    if (appIds.length === 0) {
      this.error(`No first-party apps with app.yaml found under ${appsDir}`, {
        exit: 1,
      });
    }

    // Drop the whole artifact tree first so an app removed from rome_apps/
    // does not linger as a stale packed artifact. Each app then packs into
    // its own clean subdir.
    const artifactBase = dirname(getFirstPartyArtifactDir(appIds[0], projectRoot));
    await rm(artifactBase, { recursive: true, force: true });

    // packArtifact is self-contained — absolute paths, no shared cwd, and its
    // staging/replacement dirs are keyed by the per-app outDir — so packs are
    // independent and safe to run concurrently. Bound the pool so a large
    // rome_apps/ can't spawn unbounded fs work.
    const started = Date.now();
    let nextIndex = 0;
    const failures: Array<{ appId: string; error: string }> = [];

    const worker = async (): Promise<void> => {
      while (nextIndex < appIds.length) {
        const appId = appIds[nextIndex++];
        try {
          const result = await packArtifact(
            join(appsDir, appId),
            getFirstPartyArtifactDir(appId, projectRoot),
            { appId, clean: true },
          );
          this.log(`Packed "${result.appId}@${result.version}"`);
        } catch (error) {
          failures.push({
            appId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const poolSize = Math.min(flags.concurrency, appIds.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    if (failures.length > 0) {
      for (const failure of failures) {
        log.error("pack failed", {
          appId: failure.appId,
          error: failure.error,
        });
      }
      this.error(
        `Failed to pack ${failures.length} app(s): ${failures.map((f) => f.appId).join(", ")}`,
        { exit: 1 },
      );
    }

    const durationMs = Date.now() - started;
    log.info("first-party apps packed", {
      count: appIds.length,
      durationMs,
      concurrency: poolSize,
    });
    this.log(
      `Packed ${appIds.length} first-party app(s) in ${(durationMs / 1000).toFixed(2)}s ` +
        `(concurrency ${poolSize}).`,
    );
  }
}
