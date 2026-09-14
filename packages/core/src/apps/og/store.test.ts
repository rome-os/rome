import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOgImageStore } from "./store.js";

describe("createOgImageStore", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-og-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, stats, reads and removes one file per app", async () => {
    const store = createOgImageStore(root);
    expect(store.path("@acme/radar")).toBe(join(root, "%40acme%2Fradar.v2.png"));
    expect(await store.stat("reddit")).toBeNull();
    expect(await store.read("reddit")).toBeNull();

    await store.write("reddit", Buffer.from("png-bytes"));
    const stat = await store.stat("reddit");
    expect(stat?.mtimeMs).toBeGreaterThan(0);
    expect((await store.read("reddit"))?.toString()).toBe("png-bytes");

    await store.remove("reddit");
    expect(await store.stat("reddit")).toBeNull();
    await store.remove("reddit"); // idempotent
  });
});
