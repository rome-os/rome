import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parser } from "tar";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { hashArtifact, packBundle } from "./packaging/index.js";
import { isPublishableSource, publishAppBundle } from "./publish.js";
import { setInstanceTokenInMemory } from "../lib/instance-identity.js";

// A packed source artifact dir — app.yaml at the root, build output beside
// it. node_modules is present to prove the pack/hash excludes it (it never
// travels to the store, and hashArtifact ignores it).
async function makeInstalledBundleDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rome-publish-test-"));
  const bundle = join(root, "a1b2c3hash");
  await mkdir(join(bundle, "dist"), { recursive: true });
  await mkdir(join(bundle, "src"), { recursive: true });
  await mkdir(join(bundle, "node_modules", "dep"), { recursive: true });
  await writeFile(
    join(bundle, "app.yaml"),
    "formatVersion: 1\nid: notes\nversion: 1.2.3\ndescription: t\nincludeSource: true\n",
  );
  await writeFile(join(bundle, "dist", "index.js"), "export {};\n");
  await writeFile(join(bundle, "src", "index.ts"), "export {};\n");
  await writeFile(join(bundle, "node_modules", "dep", "index.js"), "module.exports = {};\n");
  return bundle;
}

async function makeSourceArtifactWithStoreSidecar(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rome-publish-sidecar-test-"));
  const source = join(root, "notes");
  const artifact = join(source, ".rome", "artifact");
  await mkdir(join(artifact, "dist"), { recursive: true });
  await mkdir(join(source, ".rome_store", "assets"), { recursive: true });
  await writeFile(
    join(artifact, "app.yaml"),
    "formatVersion: 1\nid: notes\nversion: 1.2.3\ndescription: t\n",
  );
  await writeFile(join(artifact, "dist", "index.js"), "export {};\n");
  await writeFile(join(source, ".rome_store", "rome_store.yaml"), "title: Notes\n");
  await writeFile(join(source, ".rome_store", "assets", "hero.png"), "image-bytes\n");
  return artifact;
}

async function listTarEntries(bytes: Buffer): Promise<string[]> {
  const entries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        entries.push(entry.path);
        entry.resume();
      },
    });
    parser.on("error", reject);
    parser.on("end", () => resolve());
    parser.end(bytes);
  });
  return entries;
}

async function readTarFile(bytes: Buffer, path: string): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let found = false;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        if (entry.path === path) {
          found = true;
          entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        } else {
          entry.resume();
        }
      },
    });
    parser.on("error", reject);
    parser.on("end", () => resolve());
    parser.end(bytes);
  });
  return found ? Buffer.concat(chunks) : null;
}

/** A source artifact whose manifest carries a name and tagline but no listing. */
async function makeSourceArtifactWithoutStoreSidecar(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rome-publish-nocard-test-"));
  const source = join(root, "notes");
  const artifact = join(source, ".rome", "artifact");
  await mkdir(join(artifact, "dist"), { recursive: true });
  await writeFile(
    join(artifact, "app.yaml"),
    "formatVersion: 1\nid: notes\nname: Notes\nversion: 1.2.3\ndescription: t\n" +
      'tagline: "Everything you meant to write down."\n',
  );
  await writeFile(join(artifact, "dist", "index.js"), "export {};\n");
  return artifact;
}

const OK_PAYLOAD = {
  listing: { id: "notes", handle: "notes", slug: "notes" },
  version: {
    version: "1.2.3",
    contentHash: "c".repeat(64),
    sizeBytes: 123,
    sourceAvailable: true,
  },
  claimed: false,
};

describe("packBundle", () => {
  it("produces a single-rooted tarball with app.yaml one level deep and node_modules excluded", async () => {
    const bundle = await makeInstalledBundleDir();
    const bytes = await packBundle(bundle);
    const entries = await listTarEntries(bytes);

    const normalized = entries.map((p) => p.replace(/\/$/, ""));
    expect(normalized).toContain("a1b2c3hash/app.yaml");
    expect(normalized).toContain("a1b2c3hash/dist/index.js");
    expect(normalized).toContain("a1b2c3hash/src/index.ts");
    expect(normalized.every((p) => p.startsWith("a1b2c3hash"))).toBe(true);
    expect(normalized.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("is byte-stable across runs, so the sha256 doubles as content identity", async () => {
    const bundle = await makeInstalledBundleDir();
    const first = await packBundle(bundle);
    const second = await packBundle(bundle);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });
});

describe("isPublishableSource", () => {
  const projectRoot = "/proj";

  it("allows an app installed from a locally developed workspace", () => {
    expect(
      isPublishableSource(
        "notes",
        { mode: "bundle", path: "/home/me/.rome/default/projects/apps/notes/packed" },
        projectRoot,
      ),
    ).toBe(true);
  });

  it("refuses an app installed from the App Store", () => {
    expect(
      isPublishableSource(
        "notes",
        { mode: "appstore", listingId: "lst_1", version: "1.0.0" },
        projectRoot,
      ),
    ).toBe(false);
  });

  it("refuses a first-party app shipped with Rome", () => {
    expect(
      isPublishableSource(
        "notes",
        { mode: "bundle", path: "/proj/dist/first-party-artifacts/notes" },
        projectRoot,
      ),
    ).toBe(false);
  });

  it("refuses a first-party app reached through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "rome-publish-gate-"));
    const artifactDir = join(root, "dist", "first-party-artifacts", "notes");
    await mkdir(artifactDir, { recursive: true });
    const link = join(root, "looks-local");
    await symlink(artifactDir, link);

    expect(isPublishableSource("notes", { mode: "bundle", path: link }, root)).toBe(false);
  });
});

describe("publishAppBundle", () => {
  beforeEach(() => {
    setInstanceTokenInMemory("romeinst_test-token");
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://store.example");
    rs.stubEnv("PANTHEON_DOMAIN", "");
  });

  afterEach(() => {
    setInstanceTokenInMemory(null);
    rs.unstubAllEnvs();
  });

  it("uploads the packed bundle with the instance bearer token and a matching sha256 header", async () => {
    const bundle = await makeInstalledBundleDir();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    const result = await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    expect(result).toEqual({ status: "ok", ...OK_PAYLOAD });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://store.example/api/store/publish");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer romeinst_test-token");
    const form = captured!.init.body as FormData;
    const bundlePart = form.get("bundle") as Blob;
    const body = Buffer.from(await bundlePart.arrayBuffer());
    expect(headers["x-bundle-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    // The uploaded bytes are a real bundle the store can extract a manifest from.
    const entries = await listTarEntries(body);
    expect(entries).toContain("a1b2c3hash/app.yaml");
    // Even an app with no listing of its own ships a generated share card.
    const store = Buffer.from(await (form.get("store") as Blob).arrayBuffer());
    expect(await listTarEntries(store)).toContain(".rome_store/assets/store-card.png");
  });

  it("normalizes a legacy publish response without sourceAvailable to false", async () => {
    const bundle = await makeInstalledBundleDir();
    const legacyPayload = {
      ...OK_PAYLOAD,
      version: {
        version: OK_PAYLOAD.version.version,
        contentHash: OK_PAYLOAD.version.contentHash,
        sizeBytes: OK_PAYLOAD.version.sizeBytes,
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(legacyPayload), { status: 201 })) as typeof fetch;

    const result = await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    expect(result).toEqual({
      status: "ok",
      ...legacyPayload,
      version: { ...legacyPayload.version, sourceAvailable: false },
    });
  });

  it("attaches .rome_store as a publish sidecar without adding it to the app bundle", async () => {
    const bundle = await makeSourceArtifactWithStoreSidecar();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    const form = captured!.init.body as FormData;
    const bundlePart = form.get("bundle") as Blob;
    const storePart = form.get("store") as Blob;
    const bundleEntries = await listTarEntries(Buffer.from(await bundlePart.arrayBuffer()));
    const storeEntries = await listTarEntries(Buffer.from(await storePart.arrayBuffer()));
    expect(bundleEntries.some((entry) => entry.includes(".rome_store"))).toBe(false);
    expect(storeEntries).toContain(".rome_store/rome_store.yaml");
    expect(storeEntries).toContain(".rome_store/assets/hero.png");
  });

  it("generates a share card when the listing names no image", async () => {
    const bundle = await makeSourceArtifactWithStoreSidecar();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    const form = (captured!.init.body as FormData).get("store") as Blob;
    const store = Buffer.from(await form.arrayBuffer());
    expect(await listTarEntries(store)).toContain(".rome_store/assets/store-card.png");
    const card = await readTarFile(store, ".rome_store/assets/store-card.png");
    expect(card!.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    const listing = (await readTarFile(store, ".rome_store/rome_store.yaml"))!.toString();
    expect(listing).toContain("title: Notes");
    expect(listing).toContain("image: assets/store-card.png");
    expect(listing).toContain("image_alt:");
  });

  it("leaves a listing that names image with no value alone", async () => {
    const bundle = await makeSourceArtifactWithStoreSidecar();
    const storeRoot = join(bundle, "..", "..", ".rome_store");
    await writeFile(join(storeRoot, "rome_store.yaml"), "title: Notes\nimage:\n");
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    const store = Buffer.from(
      await ((captured!.init.body as FormData).get("store") as Blob).arrayBuffer(),
    );
    expect(await listTarEntries(store)).not.toContain(".rome_store/assets/store-card.png");
    // A second `image` key would make the store reject the listing outright.
    const listing = (await readTarFile(store, ".rome_store/rome_store.yaml"))!.toString();
    expect(listing.match(/^image:/gm)).toHaveLength(1);
  });

  it("leaves an authored image alone", async () => {
    const bundle = await makeSourceArtifactWithStoreSidecar();
    const storeRoot = join(bundle, "..", "..", ".rome_store");
    await writeFile(join(storeRoot, "rome_store.yaml"), "title: Notes\nimage: assets/hero.png\n");
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    const store = Buffer.from(
      await ((captured!.init.body as FormData).get("store") as Blob).arrayBuffer(),
    );
    expect(await listTarEntries(store)).not.toContain(".rome_store/assets/store-card.png");
    const listing = (await readTarFile(store, ".rome_store/rome_store.yaml"))!.toString();
    expect(listing).toContain("image: assets/hero.png");
  });

  it("builds a listing for an app that has none, so its card still ships", async () => {
    const bundle = await makeSourceArtifactWithoutStoreSidecar();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl });

    const store = Buffer.from(
      await ((captured!.init.body as FormData).get("store") as Blob).arrayBuffer(),
    );
    expect(await listTarEntries(store)).toContain(".rome_store/assets/store-card.png");
    const listing = (await readTarFile(store, ".rome_store/rome_store.yaml"))!.toString();
    expect(listing).toContain("image: assets/store-card.png");
    // The store derives title and description from the manifest; a card must
    // not quietly rewrite them.
    expect(listing).not.toContain("title:");
  });

  it("does not treat .rome_store edits as artifact drift before publish", async () => {
    const bundle = await makeInstalledBundleDir();
    const pinnedHash = await hashArtifact(bundle);
    await mkdir(join(bundle, ".rome_store", "assets"), { recursive: true });
    await writeFile(join(bundle, ".rome_store", "rome_store.yaml"), "title: Notes\n");
    await writeFile(join(bundle, ".rome_store", "assets", "hero.png"), "image-bytes\n");
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return new Response(JSON.stringify(OK_PAYLOAD), { status: 201 });
    }) as typeof fetch;

    const result = await publishAppBundle(bundle, pinnedHash, { fetch: fetchImpl });

    expect(result.status).toBe("ok");
    const form = captured!.init.body as FormData;
    const bundlePart = form.get("bundle") as Blob;
    const storePart = form.get("store") as Blob;
    const bundleEntries = await listTarEntries(Buffer.from(await bundlePart.arrayBuffer()));
    const storeEntries = await listTarEntries(Buffer.from(await storePart.arrayBuffer()));
    expect(bundleEntries.some((entry) => entry.includes(".rome_store"))).toBe(false);
    expect(storeEntries).toContain(".rome_store/rome_store.yaml");
    expect(storeEntries).toContain(".rome_store/assets/hero.png");
  });

  it("refuses to publish an artifact that drifted from the installed hash", async () => {
    const bundle = await makeInstalledBundleDir();
    const pinnedHash = await hashArtifact(bundle);
    await writeFile(join(bundle, "dist", "index.js"), "export const edited = true;\n");
    const fetchImpl = rs.fn() as unknown as typeof fetch;

    expect(await publishAppBundle(bundle, pinnedHash, { fetch: fetchImpl })).toEqual({
      status: "artifact_drifted",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing artifact dir instead of throwing", async () => {
    const fetchImpl = rs.fn() as unknown as typeof fetch;

    expect(
      await publishAppBundle("/nonexistent/artifact", "a".repeat(64), { fetch: fetchImpl }),
    ).toEqual({ status: "artifact_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports no_token when the instance is not enrolled", async () => {
    setInstanceTokenInMemory(null);
    const bundle = await makeInstalledBundleDir();
    const fetchImpl = rs.fn() as unknown as typeof fetch;

    expect(
      await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl }),
    ).toEqual({
      status: "no_token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unconfigured when no Rome Cloud origin is set", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "");
    const bundle = await makeInstalledBundleDir();

    expect(
      await publishAppBundle(bundle, await hashArtifact(bundle), {
        fetch: rs.fn() as unknown as typeof fetch,
      }),
    ).toEqual({ status: "unconfigured" });
  });

  it("passes the store's rejection message and status through", async () => {
    const bundle = await makeInstalledBundleDir();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Version 1.2.3 already exists for notes" }), {
        status: 409,
      })) as typeof fetch;

    expect(
      await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl }),
    ).toEqual({
      status: "rejected",
      httpStatus: 409,
      message: "Version 1.2.3 already exists for notes",
    });
  });

  it("promotes the store's instance-auth sentinels to auth_invalid", async () => {
    const bundle = await makeInstalledBundleDir();
    for (const [status, code] of [
      [403, "instance_revoked"],
      [401, "invalid_instance_token"],
    ] as const) {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ error: code }), { status })) as typeof fetch;
      expect(
        await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl }),
      ).toEqual({
        status: "auth_invalid",
      });
    }
  });

  it("keeps an ordinary 403 handle refusal as a rejection with its message", async () => {
    const bundle = await makeInstalledBundleDir();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Not authorized to publish under handle "notes"' }), {
        status: 403,
      })) as typeof fetch;
    expect(
      await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl }),
    ).toEqual({
      status: "rejected",
      httpStatus: 403,
      message: 'Not authorized to publish under handle "notes"',
    });
  });

  it("reports unreachable on network failure", async () => {
    const bundle = await makeInstalledBundleDir();
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    expect(
      await publishAppBundle(bundle, await hashArtifact(bundle), { fetch: fetchImpl }),
    ).toEqual({
      status: "unreachable",
      message: "connect ECONNREFUSED",
    });
  });
});
