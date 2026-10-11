import { existsSync } from "node:fs";
import { join } from "node:path";
import { Args, Command, Flags } from "@oclif/core";
import { createLogger } from "../../../logger.js";
import { packArtifact } from "@rome-os/app-runtime/packaging";
import { resolveFromInvokerCwd } from "../lib.js";

const log = createLogger("apps-cli");

export default class Pack extends Command {
  static override description =
    "Build a release artifact for a Rome app from a source directory containing app.yaml. " +
    "Daemon-independent. Internal build-step machinery: `pnpm build:apps` drives it for " +
    "first-party apps; dev apps pack inside the daemon via a source-mode install.";

  static override examples = [
    "pnpm --filter @rome/core app:pack rome_apps/inbox",
    "pnpm --filter @rome/core app:pack ./my-app --out ./build/inbox-artifact",
  ];

  static override args = {
    source: Args.string({
      description: "Path to the app source directory (must contain app.yaml)",
      required: true,
    }),
  };

  static override flags = {
    out: Flags.string({
      description:
        "Output artifact directory. Defaults to <source>/.rome/artifact. Must not exist or be empty unless --clean is set.",
    }),
    "app-id": Flags.string({
      description:
        "Expected app id. If provided, must match the id declared in the manifest; otherwise the command fails.",
    }),
    clean: Flags.boolean({
      description:
        "Remove the output directory before packing if it exists. Lets repeated pack invocations re-use the same --out path.",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Pack);

    const sourceRoot = resolveFromInvokerCwd(args.source);
    if (!existsSync(join(sourceRoot, "app.yaml"))) {
      throw new Error(`pack source ${sourceRoot} is missing app.yaml`);
    }

    const outDir = flags.out
      ? resolveFromInvokerCwd(flags.out)
      : join(sourceRoot, ".rome", "artifact");

    const result = await packArtifact(sourceRoot, outDir, {
      appId: flags["app-id"],
      clean: flags.clean,
    });
    this.log(`Packed "${result.appId}@${result.version}" to ${result.outDir}`);
    log.info("pack complete", {
      appId: result.appId,
      version: result.version,
      outDir: result.outDir,
    });
  }
}
