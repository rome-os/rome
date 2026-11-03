import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@rstest/core";
import { randomUUID } from "./random-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("randomUUID", () => {
  const native = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  afterEach(() => {
    if (native) Object.defineProperty(crypto, "randomUUID", native);
  });

  it("falls back to getRandomValues outside a secure context", () => {
    // Insecure origins (plain HTTP on a non-localhost host) expose `crypto`
    // without `randomUUID`.
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 100 }, () => randomUUID()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("keeps browser code off the secure-context-only crypto.randomUUID", () => {
    const offenders = sources(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").includes("crypto.randomUUID("))
      .map((path) => relative(sourceRoot, path));
    expect(offenders).toEqual(["lib/random-uuid.ts"]);
  });
});
