import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { appChangesSince, attributeAppChanges, snapshotApps } from "./app-changes.js";

describe("appChangesSince attribution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("separates known practice paths from other filesystem changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const known = join(root, "notes", "src", "known.ts");
    const other = join(root, "calendar", "src", "other.ts");
    await mkdir(join(root, "notes", "src"), { recursive: true });
    await mkdir(join(root, "calendar", "src"), { recursive: true });
    await writeFile(known, "before");
    await writeFile(other, "before");
    const before = await snapshotApps(root, copy);

    await writeFile(known, "practice changed");
    await writeFile(other, "concurrent changed");

    const changes = attributeAppChanges(await appChangesSince(root, before), new Set([known]));
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: known, attribution: "practice" }),
        expect.objectContaining({ path: other, attribution: "unattributed" }),
      ]),
    );
  });

  it("does not extend a touched file to its siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const app = join(root, "calendar");
    const shared = join(app, "src", "shared.ts");
    const other = join(app, "src", "other.ts");
    await mkdir(join(app, "src"), { recursive: true });
    const before = await snapshotApps(root, copy);
    await writeFile(shared, "practice's final content");
    await writeFile(other, "concurrent scaffold content");

    const changes = attributeAppChanges(await appChangesSince(root, before), new Set([shared]));

    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: shared, attribution: "practice" }),
        expect.objectContaining({ path: other, attribution: "unattributed" }),
      ]),
    );
  });

  it("does not attribute every file in a created app directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const app = join(root, "calendar");
    const scaffold = join(app, "src", "index.ts");
    const concurrent = join(app, "src", "guardian.ts");
    const before = await snapshotApps(root, copy);

    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(scaffold, "created by app management");
    await writeFile(concurrent, "created by another chat");

    const changes = attributeAppChanges(await appChangesSince(root, before), new Set([app]));

    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: scaffold, attribution: "unattributed" }),
        expect.objectContaining({ path: concurrent, attribution: "unattributed" }),
      ]),
    );
  });

  it("does not treat a matching path prefix as a touched directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const path = join(root, "notes-backup", "src", "other.ts");
    await mkdir(join(root, "notes-backup", "src"), { recursive: true });
    const before = await snapshotApps(root, copy);
    await writeFile(path, "changed");

    const changes = attributeAppChanges(
      await appChangesSince(root, before),
      new Set([join(root, "notes")]),
    );

    expect(changes).toContainEqual(expect.objectContaining({ path, attribution: "unattributed" }));
  });

  it("keeps a deleted known path attributed to practice", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const known = join(root, "notes", "src", "gone.ts");
    await mkdir(join(root, "notes", "src"), { recursive: true });
    await writeFile(known, "before");
    const before = await snapshotApps(root, copy);
    await rm(known);

    const changes = attributeAppChanges(await appChangesSince(root, before), new Set([known]));

    expect(changes).toContainEqual(
      expect.objectContaining({ path: known, attribution: "practice", content: "" }),
    );
  });

  it("matches equivalent filesystem path spellings", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-app-changes-"));
    const copy = await mkdtemp(join(tmpdir(), "dream-app-snapshot-"));
    roots.push(root, copy);
    const known = join(root, "notes", "src", "known.ts");
    await mkdir(join(root, "notes", "src"), { recursive: true });
    await writeFile(known, "before");
    const before = await snapshotApps(root, copy);
    await writeFile(known, "practice changed");

    const equivalent = join(root, "notes", "src", ".", "known.ts");
    const changes = attributeAppChanges(await appChangesSince(root, before), new Set([equivalent]));

    expect(changes).toContainEqual(
      expect.objectContaining({ path: known, attribution: "practice" }),
    );
  });
});
