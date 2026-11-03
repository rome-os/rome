import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export interface AppYamlWeb {
  displayName: string;
  navLabel?: string;
  entry?: string;
}

export interface AppYaml {
  id: string;
  version: string;
  icon?: string;
  appRoot?: string;
  web: AppYamlWeb;
}

export interface LoadedAppYaml {
  appDir: string;
  yaml: AppYaml;
}

export function loadAppYaml(startDir: string): LoadedAppYaml {
  const appDir = findAppDir(startDir);
  if (!appDir) {
    throw new Error(`rome: could not locate app.yaml searching upward from ${startDir}`);
  }

  const raw = readFileSync(join(appDir, "app.yaml"), "utf8");
  const parsed = parse(raw) as Partial<AppYaml> | undefined;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`rome: app.yaml at ${appDir} is empty or not an object`);
  }

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error(`rome: app.yaml is missing required field "id"`);
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`rome: app.yaml is missing required field "version"`);
  }
  if (!parsed.web || typeof parsed.web !== "object") {
    throw new Error(
      `rome: app.yaml is missing "web" section — required when running rome dev/build`,
    );
  }

  const web = parsed.web as Partial<AppYamlWeb>;
  if (typeof web.displayName !== "string" || web.displayName.length === 0) {
    throw new Error(`rome: app.yaml "web.displayName" is required (used in manifest.json)`);
  }

  const appRoot =
    typeof parsed.appRoot === "string" && parsed.appRoot.length > 0 ? parsed.appRoot : undefined;

  return {
    appDir,
    yaml: {
      id: parsed.id,
      version: parsed.version,
      icon: typeof parsed.icon === "string" && parsed.icon.length > 0 ? parsed.icon : undefined,
      appRoot,
      web: {
        displayName: web.displayName,
        navLabel: web.navLabel,
        entry: web.entry,
      },
    },
  };
}

/** The nearest directory at or above `start` that holds an app.yaml, or null. */
export function findAppDir(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "app.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
