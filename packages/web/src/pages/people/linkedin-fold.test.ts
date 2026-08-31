import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

/**
 * The LinkedIn section is gone, and this is what "gone" means on the web side.
 *
 * The section was the one part of the People page still on endpoints of its own
 * — its own fetches, its own shapes, its own copy — kept only because a
 * LinkedIn thread resolved to no person. It resolves now, so LinkedIn is a
 * channel like any other: the contract's two reads carry it into the directory
 * and the stream, and the channel-blind timeline carries it onto the person
 * page. What that section consumed alone has no second reader to keep it alive.
 *
 * `PeoplePage.test.tsx` pins what the guardian sees. This pins that the code
 * behind it left with it, because a module nobody renders still typechecks,
 * still ships in the bundle, and still reads as a live surface to whoever opens
 * it next.
 */

const peopleRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(peopleRoot, "../../..");
const localesRoot = resolve(webRoot, "src/i18n/locales");

/** Every module of the web package, tests included: a deleted endpoint left in
 *  a test fixture is still a caller of a route that no longer answers. */
function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

const webSources = [
  ...sourceFiles(resolve(webRoot, "src")),
  ...sourceFiles(resolve(webRoot, "mock")),
].filter((path) => !path.endsWith("linkedin-fold.test.ts"));

function hits(pattern: RegExp): string[] {
  return webSources.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(pattern)].map((match) => `${relative(webRoot, path)}:${match[0]}`);
  });
}

describe("the People page's LinkedIn section", () => {
  it("has no module left behind", () => {
    expect(existsSync(resolve(peopleRoot, "linkedin.tsx"))).toBe(false);
    expect(existsSync(resolve(peopleRoot, "linkedin.test.tsx"))).toBe(false);
    // Its shapes went with it. The WhatsApp half of that file described a
    // mirror this page also stopped reading, and one consumer does not need a
    // shared definition.
    expect(existsSync(resolve(peopleRoot, "channel-mirror-shapes.ts"))).toBe(false);
  });

  it("is mounted nowhere", () => {
    expect(hits(/LinkedInSection|channel-mirror-shapes/g)).toEqual([]);
  });

  it("leaves no caller of the endpoints that went with it", () => {
    // The routes are deleted server-side, so a fetch still written here is a
    // request that can only 404.
    expect(hits(/\/api\/linkedin\/(?:threads|participants)/g)).toEqual([]);
  });
});

describe("the People page's copy", () => {
  const locales = readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("covers more than one language, so the check below means something", () => {
    expect(locales.length).toBeGreaterThan(1);
  });

  it.each(locales)("carries no section-only strings in %s", (locale) => {
    const bundle = JSON.parse(
      readFileSync(resolve(localesRoot, locale, "people.json"), "utf8"),
    ) as Record<string, unknown>;

    // The section's own namespace: its heading, its empty states, its composer.
    expect(bundle.linkedin).toBeUndefined();
    // What survives is the channel's name, which every surface that names a
    // channel draws on — a pill on a row, a glyph's label on the person page.
    expect((bundle.channels as Record<string, string>).linkedin).toBeTruthy();
  });
});
