import { createHash } from "node:crypto";
import type { Rspack } from "@rslib/core";

export interface ManifestPluginOptions {
  displayName: string;
  navLabel?: string;
}

const PLUGIN_NAME = "RomeAppManifestPlugin";

export class RomeAppManifestPlugin implements Rspack.RspackPluginInstance {
  constructor(private readonly options: ManifestPluginOptions) {}

  apply(compiler: Rspack.Compiler): void {
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

function findEntryChunk(compilation: Rspack.Compilation): Rspack.Chunk | null {
  // Runtime chunks also satisfy canBeInitial(), and cached builds can change
  // compilation.chunks iteration order. Match the group's entry chunk so
  // manifest.entry cannot select a runtime file.
  return (
    [...compilation.chunks].find((chunk) =>
      [...chunk.groupsIterable].some(
        (group) => group.isInitial() && group.getEntrypointChunk() === chunk,
      ),
    ) ?? null
  );
}

function pickJsFile(files: ReadonlySet<string>): string | null {
  for (const file of files) {
    if (file.endsWith(".js") || file.endsWith(".mjs")) {
      return file;
    }
  }
  return null;
}

function collectStyles(compilation: Rspack.Compilation): string[] {
  return Object.keys(compilation.assets)
    .filter((name) => name.endsWith(".css"))
    .sort();
}

function hashAssets(compilation: Rspack.Compilation): string {
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
