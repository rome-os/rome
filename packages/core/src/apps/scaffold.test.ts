import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { getAppTemplateDir, type AppTemplateKind } from "../paths.js";
import { scaffoldDevApp } from "./scaffold.js";

function snapshotTree(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out[relative(root, abs)] = readFileSync(abs).toString("base64");
      }
    }
  }
  walk(root);
  return out;
}

describe("scaffoldDevApp", () => {
  let profileRoot: string;
  let templateDir: string;
  let devAppsDir: string;
  let appsDir: string;

  beforeEach(() => {
    profileRoot = mkdtempSync(join(tmpdir(), "rome-scaffold-profile-"));
    devAppsDir = join(profileRoot, "projects", "apps");
    appsDir = join(profileRoot, "apps");
    mkdirSync(devAppsDir, { recursive: true });
    mkdirSync(appsDir, { recursive: true });

    // Lay down a minimal app template tree under a separate location.
    // Mirrors the shape of `packages/app-template/template/`: a top-level
    // `app.yaml` plus an `actions/<name>/action.yaml`, with placeholders.
    templateDir = mkdtempSync(join(tmpdir(), "rome-scaffold-template-"));
    writeFileSync(join(templateDir, "app.yaml"), "id: __APP_ID__\nname: __APP_NAME__\n", "utf-8");
    mkdirSync(join(templateDir, ".rome_store"), { recursive: true });
    writeFileSync(
      join(templateDir, ".rome_store", "rome_store.yaml"),
      "title: __APP_NAME__\ndescription: __APP_NAME__ store listing\n",
      "utf-8",
    );
    mkdirSync(join(templateDir, "actions", "ping"), { recursive: true });
    writeFileSync(
      join(templateDir, "actions", "ping", "action.yaml"),
      "name: __APP_ID___ping\ndescription: __APP_NAME__ ping\n",
      "utf-8",
    );
  });

  afterEach(() => {
    // Cleanup is best-effort; Rstest tears the tmp dirs eventually.
  });

  it("materialises the template at the caller-supplied rootPath with placeholders applied", async () => {
    const rootPath = join(devAppsDir, "notes");
    const result = await scaffoldDevApp("notes", rootPath, { templateDir });

    expect(result).toEqual({ appId: "notes", created: true, rootPath });
    expect(statSync(rootPath).isDirectory()).toBe(true);

    // Directory tree shape: app.yaml at the root, actions/ping/action.yaml below it.
    expect(readFileSync(join(rootPath, "app.yaml"), "utf-8")).toBe("id: notes\nname: Notes\n");
    expect(readFileSync(join(rootPath, ".rome_store", "rome_store.yaml"), "utf-8")).toBe(
      "title: Notes\ndescription: Notes store listing\n",
    );
    expect(readFileSync(join(rootPath, "actions", "ping", "action.yaml"), "utf-8")).toBe(
      "name: notes_ping\ndescription: Notes ping\n",
    );
  });

  it("materialises into an arbitrary rootPath (e.g. an app_creation working tree) outside the canonical layout", async () => {
    // Always-fork callers pass paths that have nothing to do with
    // `~/.rome/<profile>/projects/apps/`. scaffold must honor whatever
    // absolute path it gets.
    const worktreeRoot = mkdtempSync(join(tmpdir(), "rome-scaffold-worktree-"));
    const rootPath = join(worktreeRoot, "notes-session-abc");

    const result = await scaffoldDevApp("notes", rootPath, { templateDir });

    expect(result.rootPath).toBe(rootPath);
    expect(readFileSync(join(rootPath, "app.yaml"), "utf-8")).toBe("id: notes\nname: Notes\n");
  });

  it("does NOT touch the deployment.yaml for the new appId (snapshot byte-identical before/after)", async () => {
    // Pre-populate a deployment.yaml for the same appId — scaffold must leave
    // it untouched. This is the load-bearing invariant from ZHA-55: `create`
    // is filesystem-scaffold-only, it does NOT cross into the spec-write API.
    const appSpecDir = join(appsDir, "notes");
    mkdirSync(appSpecDir, { recursive: true });
    const deploymentYamlPath = join(appSpecDir, "deployment.yaml");
    const originalDeploymentYaml = "spec:\n  enabled: true\n  source:\n    mode: workspace\n";
    writeFileSync(deploymentYamlPath, originalDeploymentYaml, "utf-8");

    const beforeAppsTree = snapshotTree(appsDir);

    await scaffoldDevApp("notes", join(devAppsDir, "notes"), { templateDir });

    const afterAppsTree = snapshotTree(appsDir);
    expect(afterAppsTree).toEqual(beforeAppsTree);

    // Spot-check the bytes too — equality of the snapshot map already proves
    // it, but this asserts at the file level for a more legible failure.
    expect(readFileSync(deploymentYamlPath, "utf-8")).toBe(originalDeploymentYaml);
  });

  it("refuses to overwrite an existing non-empty dev directory", async () => {
    const existingRoot = join(devAppsDir, "notes");
    mkdirSync(existingRoot, { recursive: true });
    writeFileSync(join(existingRoot, "marker"), "x");

    await expect(scaffoldDevApp("notes", existingRoot, { templateDir })).rejects.toThrow(
      /already exists and is non-empty/,
    );
  });

  it("rejects invalid app ids before touching the filesystem", async () => {
    const rootPath = join(devAppsDir, "Bad-Id");
    await expect(scaffoldDevApp("Bad-Id", rootPath, { templateDir })).rejects.toThrow(
      /Invalid app id/,
    );
    expect(existsSync(rootPath)).toBe(false);
  });

  it("keeps app scaffolds on unscoped local ids", async () => {
    const rootPath = join(devAppsDir, "%40foo%2Fbar");
    await expect(scaffoldDevApp("@foo/bar", rootPath, { templateDir })).rejects.toThrow(
      /create with an unscoped local app id/,
    );
    expect(existsSync(rootPath)).toBe(false);
  });

  it("rejects a non-absolute rootPath", async () => {
    await expect(scaffoldDevApp("notes", "relative/path/notes", { templateDir })).rejects.toThrow(
      /absolute path/,
    );
  });

  it("pins bundled app templates to pnpm 11", () => {
    const templateKinds: AppTemplateKind[] = ["default", "workflow"];
    for (const kind of templateKinds) {
      const pkg = JSON.parse(
        readFileSync(join(getAppTemplateDir(kind), "package.json"), "utf-8"),
      ) as { packageManager?: string; scripts?: Record<string, string> };
      expect(pkg.packageManager).toBe("pnpm@11.6.0");
      expect(pkg.scripts?.test ?? "").not.toContain("scripts/test-env.sh");
    }
  });

  it("ships bundled app templates with format v2 canonical artifact references", () => {
    const templateKinds: AppTemplateKind[] = ["default", "workflow"];
    for (const kind of templateKinds) {
      const templateRoot = getAppTemplateDir(kind);
      const manifest = readFileSync(join(templateRoot, "app.yaml"), "utf-8");
      expect(manifest).toContain("formatVersion: 2");
      expect(manifest).toContain("includeSource: true");
    }

    const defaultRoot = getAppTemplateDir("default");
    expect(
      readFileSync(join(defaultRoot, "src", "actions", "hello", "action.yaml"), "utf-8"),
    ).toContain("name: hello");
    const defaultApi = readFileSync(join(defaultRoot, "src", "api", "index.ts"), "utf-8");
    expect(defaultApi).toContain('runAction("__APP_ID__:hello"');
    expect(defaultApi).not.toContain("__APP_ID___hello");
    const askAgent = readFileSync(
      join(defaultRoot, "src", "actions", "ask-agent", "index.ts"),
      "utf-8",
    );
    expect(askAgent).toContain('runAction("system:summon"');
    expect(askAgent).toContain('agentName: "__APP_ID__:demo"');
    expect(readFileSync(join(defaultRoot, "src", "agents", "demo.yaml"), "utf-8")).toContain(
      "name: demo",
    );

    const workflowRoot = getAppTemplateDir("workflow");
    expect(
      readFileSync(join(workflowRoot, "src", "actions", "run", "action.yaml"), "utf-8"),
    ).toContain("name: run");
    const workflowApi = readFileSync(join(workflowRoot, "src", "api", "index.ts"), "utf-8");
    expect(workflowApi).toContain('runAction("__APP_ID__:run"');
    expect(workflowApi).not.toContain("__APP_TABLE_PREFIX___run");
  });

  it("ships store sidecar metadata with bundled app templates", () => {
    const templateKinds: AppTemplateKind[] = ["default", "workflow"];
    for (const kind of templateKinds) {
      const templateRoot = getAppTemplateDir(kind);
      const storeYamlPath = join(templateRoot, ".rome_store", "rome_store.yaml");
      expect(existsSync(join(templateRoot, "README.md"))).toBe(true);
      expect(existsSync(storeYamlPath)).toBe(true);
      expect(existsSync(join(templateRoot, ".rome_store", "assets", ".gitkeep"))).toBe(true);

      const storeYaml = readFileSync(storeYamlPath, "utf-8");
      expect(storeYaml).toContain("title: __APP_NAME__");
      expect(storeYaml).toContain("description:");
      expect(storeYaml).toContain("categories:");
      expect(storeYaml).not.toContain("seo:");
    }
  });

  it("scaffolds the web UI on the published component kit, not on copied primitives", () => {
    const templateRoot = getAppTemplateDir("default");

    // A snapshot copy of a kit component is frozen at scaffold time: the app
    // can never receive a fix. Importing means `pnpm up @rome-os/ui` is the
    // whole upgrade path.
    expect(existsSync(join(templateRoot, "src", "web", "components", "ui"))).toBe(false);

    const pkg = JSON.parse(readFileSync(join(templateRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain("@rome-os/ui");

    const appEntry = readFileSync(join(templateRoot, "src", "web", "App.tsx"), "utf-8");
    expect(appEntry).not.toContain("@/components/ui/");
    for (const subpath of ["button", "card", "select"]) {
      expect(appEntry).toContain(`from "@rome-os/ui/${subpath}"`);
    }

    // One import. `@rome-os/ui` is an optional peer of the SDK, so the kit the
    // app declares above is the only copy in the tree, and the canon reaches the
    // bundle through the SDK sheet. Importing the canon here as well resolves to
    // that same copy and adds nothing.
    const appStyles = readFileSync(join(templateRoot, "src", "web", "styles.css"), "utf-8");
    expect(appStyles).toContain('@import "@rome-os/app-web-sdk/styles"');
    expect(appStyles).not.toContain('@import "@rome-os/ui/styles.css"');
  });

  it("depends on every published Rome package through a concrete semver range", () => {
    // A scaffolded app installs from npm on a user's machine, so `workspace:*`
    // does not resolve and `latest` silently ships whatever the registry holds
    // at install time. REFERENCE.md tells app authors the same rule; the
    // templates are where they read it from.
    const templateKinds: AppTemplateKind[] = ["default", "workflow"];
    for (const kind of templateKinds) {
      const pkg = JSON.parse(
        readFileSync(join(getAppTemplateDir(kind), "package.json"), "utf-8"),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const romeRanges = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
        ([name]) => name.startsWith("@rome-os/"),
      );
      expect(romeRanges.length).toBeGreaterThan(0);
      for (const [name, range] of romeRanges) {
        expect(`${kind} ${name} ${range}`).toMatch(/\^\d+\.\d+\.\d+$/);
      }
    }
  });
});
