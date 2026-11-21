import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { getAssetsDir } from "../paths.js";
import { registerShowFileAction } from "./show-file-action.js";
import { AssetSourceError, AssetTooLargeError, storeAssetFromPath } from "./store.js";

describe("showing a local file", () => {
  let home: string;
  let projects: string;
  let profile: string;
  let outside: string;
  let testDb: TestDb;
  let engine: ActionEngine;
  const fork = rs.fn(() => {
    throw new Error("show_file must run in main");
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rome-show-file-"));
    profile = join(home, ".rome", "show-file-test");
    projects = join(profile, "projects");
    outside = join(home, "outside");
    mkdirSync(join(projects, "default"), { recursive: true });
    mkdirSync(join(profile, "memory"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    rs.stubEnv("HOME", home);
    rs.stubEnv("ROME_PROFILE", "show-file-test");
    rs.stubEnv("ROME_PROJECTS_ROOT", projects);
    testDb = createTestDb();
    const registry = new ActionRegistryImpl();
    registerShowFileAction(registry);
    engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
      processRole: "main",
      workerWarmPoolSize: 0,
      isFirstPartyAction: (name) => name === "core:show_file",
      actionWorkerFork: fork,
    });
  });

  afterEach(() => {
    testDb.close();
    rs.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const write = (path: string, data = "x") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, data);
    return path;
  };
  const show = (path: unknown) => engine.run("core:show_file", { path }, {});

  describe("the action", () => {
    it("returns the URL and an image Markdown for a picture, in main", async () => {
      const path = write(join(projects, "default", "shots", "after.PNG"), "png-bytes");
      const result = await show(path);

      expect(result.status).toBe("ok");
      const data = (result as { data: { url: string; markdown: string } }).data;
      expect(data.url).toMatch(/^\/api\/assets\/[0-9a-f]{32}\.png$/);
      expect(data.markdown).toBe(`![after.PNG](${data.url})`);
      expect(readFileSync(join(getAssetsDir(), data.url.split("/").pop() as string), "utf-8")).toBe(
        "png-bytes",
      );
      expect(fork).not.toHaveBeenCalled();
    });

    it.each([
      ["clip.mp4", "[clip.mp4]"],
      ["report.pdf", "[report.pdf]"],
      ["notes.txt", "[notes.txt]"],
      ["logo.svg", "![logo.svg]"],
      ["photo.webp", "![photo.webp]"],
      ["no-extension", "[no-extension]"],
    ])("labels %s as %s", async (name, label) => {
      const result = await show(write(join(projects, "default", name)));
      const data = (result as { data: { url: string; markdown: string } }).data;
      expect(data.markdown).toBe(`${label}(${data.url})`);
    });

    it("escapes brackets in the label", async () => {
      const result = await show(write(join(projects, "default", "a[1](x).png")));
      const data = (result as { data: { markdown: string } }).data;
      expect(data.markdown.startsWith("![a\\[1\\](x).png](/api/assets/")).toBe(true);
    });

    it("answers a clear error, never a throw", async () => {
      write(join(projects, ".env"), "KEY=1");
      for (const [path, message] of [
        ["relative/a.png", "Path must be an absolute path"],
        [42, "Path must be an absolute path"],
        [join(projects, "missing.png"), "File not found"],
        [join(projects, "default"), "Not a regular file"],
        ["/etc/passwd", "outside the folders"],
        [join(projects, ".env"), "sensitive file"],
      ] as const) {
        const result = await show(path);
        expect(result.status, String(path)).toBe("error");
        expect((result as { error: string }).error).toContain(message);
      }
    });

    it("is offered to the Concierge allow-list and the main agent wildcard", () => {
      const registry = new ActionRegistryImpl();
      registerShowFileAction(registry);
      for (const names of [["core:show_file"], ["*"]]) {
        expect(registry.getForAgent(names).map((action) => action.config.name)).toContain(
          "core:show_file",
        );
      }
    });
  });

  describe("storeAssetFromPath", () => {
    it("copies from the projects folder, the memory folder and the assets folder", async () => {
      const inProjects = await storeAssetFromPath(write(join(projects, "a.png"), "p"));
      const inMemory = await storeAssetFromPath(
        write(join(profile, "memory", "pics", "m.png"), "m"),
      );
      const again = await storeAssetFromPath(inProjects.path);

      expect(readFileSync(inProjects.path, "utf-8")).toBe("p");
      expect(readFileSync(inMemory.path, "utf-8")).toBe("m");
      expect(readFileSync(again.path, "utf-8")).toBe("p");
      expect(again.id).not.toBe(inProjects.id);
      expect(statSync(inProjects.path).mode & 0o777).toBe(0o444);
      expect(readdirSync(join(getAssetsDir(), ".tmp"))).toEqual([]);
    });

    it("lets a file under projects/.rome through", async () => {
      const stored = await storeAssetFromPath(
        write(join(projects, ".rome", "generated-images", "image-1.png")),
      );
      expect(stored.url).toMatch(/\.png$/);
    });

    it.each([
      ["/etc/passwd"],
      ["profile:rome.db"],
      ["profile:apps/installed/app.json"],
      ["profile:memory/../rome.db"],
      ["home:outside/a.png"],
    ])("refuses %s as outside the allowed folders", async (spec) => {
      const path = spec.startsWith("profile:")
        ? write(join(profile, spec.slice(8)))
        : spec.startsWith("home:")
          ? write(join(home, spec.slice(5)))
          : spec;
      await expect(storeAssetFromPath(path)).rejects.toThrow(/outside the folders|sensitive/);
      await expect(storeAssetFromPath(path)).rejects.toBeInstanceOf(AssetSourceError);
    });

    it("refuses a .. path that climbs out of the projects folder", async () => {
      write(join(profile, "other.txt"), "no");
      const climbing = join(projects, "default", "..", "..", "other.txt");
      await expect(storeAssetFromPath(climbing)).rejects.toThrow("outside the folders");
    });

    it("refuses a link that points outside the allowed folders", async () => {
      const target = write(join(outside, "key-material.txt"), "secret bytes");
      const link = join(projects, "default", "innocent.txt");
      symlinkSync(target, link);
      await expect(storeAssetFromPath(link)).rejects.toThrow("outside the folders");
      const dirLink = join(projects, "linkdir");
      symlinkSync(outside, dirLink);
      await expect(storeAssetFromPath(join(dirLink, "key-material.txt"))).rejects.toThrow(
        "outside the folders",
      );
    });

    it("follows a link that points at an allowed file", async () => {
      const target = write(join(projects, "real", "photo.png"), "real bytes");
      const link = join(projects, "default", "alias.png");
      symlinkSync(target, link);
      const stored = await storeAssetFromPath(link);
      expect(readFileSync(stored.path, "utf-8")).toBe("real bytes");
    });

    it("judges a link by what it resolves to", async () => {
      const target = write(join(projects, ".env"), "KEY=1");
      const link = join(projects, "default", "harmless.txt");
      symlinkSync(target, link);
      await expect(storeAssetFromPath(link)).rejects.toThrow("sensitive file");
    });

    it.each([
      ".env",
      ".ENV",
      ".env.local",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa_work",
      "x.pem",
      "SERVER.KEY",
      "cert.p12",
      "cert.pfx",
      ".ssh/config",
      "repo/.git/config",
      ".aws/config",
      ".gnupg/pubring.kbx",
      ".docker/config.json",
      ".kube/config",
      "foo.db",
      "foo.sqlite",
      "foo.sqlite3",
      "foo.db-wal",
      "foo.db-shm",
      "aws-credentials.json",
      "My-Secret-Notes.md",
    ])("refuses the sensitive file %s", async (name) => {
      const path = write(join(projects, "default", name));
      await expect(storeAssetFromPath(path)).rejects.toThrow("sensitive file");
    });

    it.each([
      "id_rsa.pub",
      "id_ed25519.pub",
      "env.png",
      "keys.png",
      "envelope.txt",
    ])("allows %s", async (name) => {
      await expect(
        storeAssetFromPath(write(join(projects, "default", name))),
      ).resolves.toBeTruthy();
    });

    it("refuses a directory, a missing file and a relative path", async () => {
      await expect(storeAssetFromPath(join(projects, "default"))).rejects.toThrow(
        "Not a regular file",
      );
      await expect(storeAssetFromPath(join(projects, "nope.png"))).rejects.toThrow(
        "File not found",
      );
      await expect(storeAssetFromPath("a.png")).rejects.toThrow("absolute");
    });

    it("refuses a named pipe without hanging", async () => {
      const fifo = join(projects, "default", "pipe.png");
      execFileSync("mkfifo", [fifo]);
      await expect(storeAssetFromPath(fifo)).rejects.toThrow("Not a regular file");
    });

    it("refuses a file over the cap", async () => {
      const path = write(join(projects, "big.bin"), "12345678901");
      await expect(storeAssetFromPath(path, { maxBytes: 10 })).rejects.toBeInstanceOf(
        AssetTooLargeError,
      );
      await expect(storeAssetFromPath(path, { maxBytes: 11 })).resolves.toBeTruthy();
    });

    it("copies an empty file", async () => {
      const stored = await storeAssetFromPath(write(join(projects, "empty.txt"), ""));
      expect(stored.size).toBe(0);
      expect(readFileSync(stored.path, "utf-8")).toBe("");
    });

    it("keeps the old bytes when the source is overwritten and shown again", async () => {
      const path = write(join(projects, "default", "after.png"), "round one");
      const first = await storeAssetFromPath(path);
      writeFileSync(path, "round two");
      const second = await storeAssetFromPath(path);

      expect(second.url).not.toBe(first.url);
      expect(readFileSync(first.path, "utf-8")).toBe("round one");
      expect(readFileSync(second.path, "utf-8")).toBe("round two");
    });
  });
});
