import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { parseCss } from "./tailwind-policy.mjs";

const repoRoot = join(import.meta.dirname, "..");
const dependencyRoot = join(repoRoot, "packages", "app-web-sdk");

function cssFiles(directory) {
  const files = [];
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !["dist", "dist-mock", "node_modules"].includes(entry.name)) {
        queue.push(join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        files.push(join(current, entry.name));
      }
    }
  }

  return files.sort();
}

async function declarationsByToken(directory, generatedSources = []) {
  const declarations = new Map();

  const sources = [
    ...cssFiles(directory).map((file) => ({ file, css: readFileSync(file, "utf8") })),
    ...generatedSources,
  ];
  for (const { file, css } of sources) {
    const root = await parseCss(css, { dependencyRoot, from: file });
    root.walkDecls(/^--/, (declaration) => {
      const files = declarations.get(declaration.prop) ?? new Set();
      files.add(file);
      declarations.set(declaration.prop, files);
    });
  }

  return declarations;
}

async function generatedThemeSource() {
  const themeModule = await tsImport(
    join(repoRoot, "packages", "web", "src", "lib", "theme.ts"),
    import.meta.url,
  );
  return {
    file: join(repoRoot, "packages", "web", "src", "lib", "themes.ts"),
    css: themeModule.buildThemeCss(themeModule.getThemeDefinitions()),
  };
}

async function overlappingDeclarations(packages, generatedSources = {}) {
  const [web, ui] = await Promise.all([
    declarationsByToken(packages.web, generatedSources.web),
    declarationsByToken(packages.ui, generatedSources.ui),
  ]);

  return [...web.keys()]
    .filter((token) => ui.has(token))
    .sort()
    .map((token) => ({
      token,
      web: [...web.get(token)].sort(),
      ui: [...ui.get(token)].sort(),
    }));
}

function formatOverlaps(overlaps, displayRoot) {
  return overlaps
    .flatMap(({ token, web, ui }) => [
      `${token} is declared by both packages:`,
      ...web.map((file) => `  ${relative(displayRoot, file)}`),
      ...ui.map((file) => `  ${relative(displayRoot, file)}`),
    ])
    .join("\n");
}

async function assertDisjointDeclarations(packages, displayRoot, generatedSources) {
  const overlaps = await overlappingDeclarations(packages, generatedSources);
  assert.deepEqual(overlaps, [], formatOverlaps(overlaps, displayRoot));
}

test("packages/web and packages/ui declare disjoint token names", async () => {
  await assertDisjointDeclarations(
    {
      web: join(repoRoot, "packages", "web"),
      ui: join(repoRoot, "packages", "ui"),
    },
    repoRoot,
    { web: [await generatedThemeSource()] },
  );
});

test("a shared declaration reports the token and both declaring files", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rome-token-ownership-"));
  const packages = {
    web: join(fixtureRoot, "packages", "web"),
    ui: join(fixtureRoot, "packages", "ui"),
  };
  const webFile = join(packages.web, "src", "globals.css");
  const uiFile = join(packages.ui, "src", "styles.css");
  mkdirSync(join(packages.web, "src"), { recursive: true });
  mkdirSync(join(packages.ui, "src"), { recursive: true });
  writeFileSync(webFile, ":root { --radius-sm: 6px; }\n");
  writeFileSync(uiFile, "@theme inline { --radius-sm: var(--radius); }\n");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(assertDisjointDeclarations(packages, fixtureRoot), (error) => {
    assert.match(error.message, /--radius-sm is declared by both packages/);
    assert.match(error.message, /packages\/web\/src\/globals\.css/);
    assert.match(error.message, /packages\/ui\/src\/styles\.css/);
    return true;
  });
});

test("a generated web declaration participates in the ownership check", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rome-token-ownership-generated-"));
  const packages = {
    web: join(fixtureRoot, "packages", "web"),
    ui: join(fixtureRoot, "packages", "ui"),
  };
  const uiFile = join(packages.ui, "src", "styles.css");
  const themeFile = join(packages.web, "src", "lib", "themes.ts");
  mkdirSync(packages.web, { recursive: true });
  mkdirSync(join(packages.ui, "src"), { recursive: true });
  writeFileSync(uiFile, ":root { --neutral-500: #777; }\n");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(
    assertDisjointDeclarations(packages, fixtureRoot, {
      web: [{ file: themeFile, css: '[data-theme="test"] { --neutral-500: #888; }' }],
    }),
    (error) => {
      assert.match(error.message, /--neutral-500 is declared by both packages/);
      assert.match(error.message, /packages\/web\/src\/lib\/themes\.ts/);
      assert.match(error.message, /packages\/ui\/src\/styles\.css/);
      return true;
    },
  );
});
