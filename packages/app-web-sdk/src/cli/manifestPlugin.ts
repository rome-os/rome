import { createHash } from "node:crypto";
import type { Chunk, Compilation, Compiler, RspackPluginInstance } from "@rspack/core";

export interface ManifestPluginOptions {
  displayName: string;
  navLabel?: string;
}

const PLUGIN_NAME = "RomeAppManifestPlugin";

export class RomeAppManifestPlugin implements RspackPluginInstance {
  constructor(private readonly options: ManifestPluginOptions) {}

  apply(compiler: Compiler): void {
    const { webpack } = compiler;
    const { sources } = webpack;

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
        },
        () => {
          const entryChunk = findEntryChunk(compilation);
          if (!entryChunk) {
            compilation.errors.push(
              new webpack.WebpackError(
                `${PLUGIN_NAME}: missing entry chunk for Rome app web build`,
              ),
            );
            return;
          }

          const entryFile = pickJsFile(entryChunk.files);
          if (!entryFile) {
            compilation.errors.push(
              new webpack.WebpackError(`${PLUGIN_NAME}: entry chunk has no JS file`),
            );
            return;
          }

          const styles = collectStyles(compilation);
          const assetVersion = hashAssets(compilation);

          const manifest = {
            entry: entryFile,
            styles,
            assetVersion,
            displayName: this.options.displayName,
            navLabel: this.options.navLabel ?? this.options.displayName,
            routing: "client" as const,
          };

          compilation.emitAsset(
            "manifest.json",
            new sources.RawSource(JSON.stringify(manifest, null, 2)),
          );
        },
      );
    });
  }
}

/** The chunk holding the generated entry module, which is the one that exports
 *  `mount`. Read it off the entrypoint rather than scanning `compilation.chunks`
 *  for the first initial chunk: an app whose build splits a runtime chunk out —
 *  any app with a dynamic import — has two initial chunks, and the runtime one
 *  exports nothing. Which of them came first depended on the module graph, so a
 *  source edit could silently repoint the manifest at the runtime chunk and the
 *  host would fail to mount the app. */
export function findEntryChunk(compilation: Compilation): Chunk | null {
  for (const entrypoint of compilation.entrypoints.values()) {
    const chunk = entrypoint.getEntrypointChunk();
    if (chunk) {
      return chunk;
    }
  }
  return null;
}

function pickJsFile(files: ReadonlySet<string>): string | null {
  for (const file of files) {
    if (file.endsWith(".js") || file.endsWith(".mjs")) {
      return file;
    }
  }
  return null;
}

function collectStyles(compilation: Compilation): string[] {
  return Object.keys(compilation.assets)
    .filter((name) => name.endsWith(".css"))
    .sort();
}

function hashAssets(compilation: Compilation): string {
  const hash = createHash("sha256");
  const names = Object.keys(compilation.assets).sort();
  for (const name of names) {
    hash.update(name);
    const asset = compilation.assets[name];
    const source = asset?.source();
    if (source !== undefined) {
      hash.update(source);
    }
  }
  return hash.digest("hex").slice(0, 12);
}
