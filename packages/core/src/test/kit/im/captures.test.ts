import { describe, expect, it } from "@rstest/core";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCapture } from "./capture.js";

const directory = fileURLToPath(new URL("./captures/", import.meta.url));
const files = readdirSync(directory).filter((name) => name.endsWith(".capture.json"));

// What a credential that survived sanitizing tends to look like.
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["Telegram bot token", /\d{6,}:[\w-]{30,}/],
  ["bearer credential", /bearer\s+[\w.~+/-]{16,}/i],
  ["JWT", /eyJ[\w-]{10,}\.[\w-]{10,}/],
  ["long opaque run", /[A-Za-z0-9+_=-]{40,}/],
];

function strings(value: unknown, path = "$"): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [
      [`${path}.${key}#key`, key] as [string, string],
      ...strings(item, `${path}.${key}`),
    ]);
  return [];
}

describe.each(files)("%s", (file) => {
  const raw: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));

  it("follows the capture format", () => {
    expect(() => loadCapture(raw)).not.toThrow();
  });

  it("holds nothing shaped like a credential", () => {
    const found = strings(raw).flatMap(([path, text]) =>
      SECRET_SHAPES.filter(([, shape]) => shape.test(text)).map(([name]) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });
});
