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

  it("keys the card on the host it prints, following a host that changes", async () => {
    let host: string | null = "pool-7.romeos.cc";
    const store = createOgImageStore(root, () => host);
    const poolPath = store.path("reddit");

    await store.write("reddit", Buffer.from("pool-card"));
    host = "acme.romeos.cc";

    expect(store.path("reddit")).not.toBe(poolPath);
    expect(store.path("reddit")).toMatch(/reddit\.v2\.[0-9a-f]{8}\.png$/);
    expect(await store.stat("reddit")).toBeNull();
    expect(await store.read("reddit")).toBeNull();

    await store.write("reddit", Buffer.from("acme-card"));
    expect((await store.read("reddit"))?.toString()).toBe("acme-card");
    host = "pool-7.romeos.cc";
    expect((await store.read("reddit"))?.toString()).toBe("pool-card");
  });

  it("keeps the plain name when the instance has no public host", () => {
    expect(createOgImageStore(root, () => null).path("reddit")).toBe(join(root, "reddit.v2.png"));
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
