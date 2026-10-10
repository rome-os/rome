import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function sourceAliases(packageRoot: URL): Record<string, string> {
  const { name, exports } = JSON.parse(
    readFileSync(new URL("package.json", packageRoot), "utf8"),
  ) as { name: string; exports: Record<string, string | { default: string }> };

  return Object.fromEntries(
    Object.entries(exports).map(([subpath, entry]) => {
      const target = typeof entry === "string" ? entry : entry.default;
      const candidates =
        target.startsWith("./dist/") && target.endsWith(".js")
          ? [".ts", ".tsx"].map((extension) =>
              target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, extension),
            )
          : [target];
      const source = candidates.map((path) => new URL(path, packageRoot)).find(existsSync);
      if (!source) throw new Error(`Missing workspace source for ${name}${subpath.slice(1)}`);
      return [`${name}${subpath.slice(1)}$`, fileURLToPath(source)];
    }),
  );
}
