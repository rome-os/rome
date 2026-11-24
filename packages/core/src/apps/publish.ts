/**
 * Publish an installed app to the Rome App Store.
 *
 * Publishes the **pinned source artifact** (the packed dir the app was
 * installed from), never the materialized install dir — `prepare()` runs
 * `pnpm install` inside the install dir, which can generate files (e.g. a
 * `pnpm-lock.yaml`) that were not part of the authored artifact. The artifact
 * is integrity-checked against the lockfile's `installedHash` before upload,
 * so the published bytes are exactly what is installed. The artifact is packed
 * into the same deterministic single-rooted gzipped tarball the `rome publish`
 * CLI produces (portable, noMtime, node_modules excluded) and uploaded to the
 * store's `POST /api/store/publish` authenticated by the instance token.
 * Version / handle policy is enforced entirely by the store; its
 * rejection messages pass through verbatim so the caller can surface them.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, dirname, basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { create as tarCreate } from "tar";
import {
  hashArtifact,
  packBundle,
  parseAppManifest,
  parseManifestObject,
  resolvePathWithinBase,
  safeIsFile,
  sourceRootForArtifactPath,
} from "./packaging/index.js";
import { renderOgSvg, type OgIcon } from "./og/template.js";
import { svgToPng } from "./og/rasterize.js";
import type { SpecSource } from "./lockfile.js";
import type { AppCatalog } from "./catalog.js";
import { SYSTEM_APP_ID } from "./manager.js";
import { isValidAppId } from "./packaging/app-id.js";
import { cloudBearer } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { createLogger } from "../logger.js";
import { getFirstPartyArtifactDir, getProjectRoot } from "../paths.js";

const log = createLogger("apps-publish");

/** Interactive operation — long enough for a 50 MB upload on a slow link, short enough to fail loudly. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 60_000;

export type PublishAppResult =
  | {
      status: "ok";
      listing: { id: string; handle: string; slug: string };
      version: {
        version: string;
        contentHash: string;
        sizeBytes: number;
        sourceAvailable: boolean;
      };
      claimed: boolean;
    }
  /** The source artifact dir is missing or unreadable — re-install first. */
  | { status: "artifact_missing" }
  /** The source artifact no longer matches the installed hash — re-install first. */
  | { status: "artifact_drifted" }
  /** Instance not enrolled — no `ROME_INSTANCE_TOKEN` in the environment. */
  | { status: "no_token" }
  /**
   * The store refused the instance credential itself (`invalid_instance_token`
   * or `instance_revoked`) — terminal until the instance is reconnected to its
   * Rome account, unlike per-app `rejected` refusals.
   */
  | { status: "auth_invalid" }
  /** No Rome Cloud origin configured for this instance. */
  | { status: "unconfigured" }
  /** Network failure or timeout — transient, safe to retry. */
  | { status: "unreachable"; message: string }
  /** The store accepted the request but refused the publish (auth, version policy, …). */
  | { status: "rejected"; httpStatus: number; message: string };

/**
 * Whether an installed app is eligible to publish from this instance: only
 * apps installed from local sources the user authored (`source` workspaces
 * and non-first-party `bundle` dirs). Store installs are someone else's
 * listing (the store would refuse the handle anyway), and first-party
 * artifacts under `dist/first-party-artifacts/` ship with every Rome
 * instance. Single source of truth for the gate — both the card's
 * `canPublish` flag and the publish route call this.
 */
export function isPublishableSource(
  appId: string,
  source: SpecSource,
  projectRoot: string = getProjectRoot(),
): boolean {
  if (source.mode === "appstore") return false;
  if (source.mode === "source") return true;
  return canonicalPath(source.path) !== canonicalPath(getFirstPartyArtifactDir(appId, projectRoot));
}

/**
 * The packed-artifact dir whose bytes a publish ships, for a local install
 * source. For `source` mode that is the daemon-managed pack target inside the
 * workspace (`<repo>/.rome/artifact` — written on every install), never the raw
 * source tree. Appstore installs have no local artifact to publish.
 */
export function publishArtifactRoot(source: SpecSource): string | null {
  if (source.mode === "bundle") return source.path;
  if (source.mode === "source") return resolve(source.path, ".rome", "artifact");
  return null;
}

// Symlink-resolving canonicalization: a workspace source recorded via a
// symlink into dist/first-party-artifacts/ must still be recognized as
// first-party, so both sides of the comparison go through realpath. Paths
// that no longer exist can't be symlinks; lexical resolve() is exact there.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** How publishing an installed app ended: the listing and version it
 * published, or why not, as the error and the HTTP status the Apps page gets. */
export type PublishInstalledAppOutcome =
  | (Extract<PublishAppResult, { status: "ok" }> & { appId: string })
  | { status: "refused"; httpStatus: 400 | 403 | 404 | 409 | 412 | 501 | 502; error: string }
  | { status: "rejected"; httpStatus: number; error: string };

/**
 * Publishes an installed app to the Rome App Store, as the Apps page's Publish
 * does. Only an app developed on this instance publishes; every other case is
 * refused with what to do instead. `rejected` carries the store's own refusal,
 * such as a version it already holds.
 */
export async function publishInstalledApp(
  catalog: Pick<AppCatalog, "get">,
  appId: string,
  opts: PublishAppOptions = {},
): Promise<PublishInstalledAppOutcome> {
  const refused = (httpStatus: 400 | 403 | 404 | 409 | 412 | 501 | 502, error: string) =>
    ({ status: "refused", httpStatus, error }) as const;
  if (!isValidAppId(appId)) return refused(400, "Invalid app id");
  if (appId === SYSTEM_APP_ID) {
    return refused(400, 'SYSTEM_PROTECTED: App "system" cannot be published');
  }
  const view = catalog.get(appId);
  if (!view) return refused(404, `App "${appId}" is not installed`);
  if (view.state !== "installed") {
    return refused(409, `App "${appId}" is ${view.state}; cannot publish`);
  }
  const artifactRoot = publishArtifactRoot(view.source);
  if (artifactRoot == null || !isPublishableSource(appId, view.source)) {
    return refused(
      409,
      `App "${appId}" was not developed on this instance; only locally developed apps can be published`,
    );
  }
  if (view.installedHash == null) {
    return refused(409, `App "${appId}" has no pinned install hash; re-install before publishing`);
  }
  // The pinned source artifact, never the install dir (module comment). Nothing
  // here needs the app running, so a disabled app publishes too.
  const result = await publishAppBundle(artifactRoot, view.installedHash, opts);
  switch (result.status) {
    case "ok":
      return { ...result, appId };
    case "artifact_missing":
      return refused(
        409,
        `The source artifact for "${appId}" is no longer at ${artifactRoot}; re-install it before publishing`,
      );
    case "artifact_drifted":
      return refused(
        409,
        `The source artifact for "${appId}" has changed since it was installed; install it again before publishing`,
      );
    case "no_token":
      return refused(
        412,
        "This Rome instance is not connected to a Rome account, so it cannot publish to the App Store.",
      );
    case "auth_invalid":
      return refused(
        403,
        "The App Store no longer accepts this Rome instance's credentials. Reconnect this instance to its Rome account and try again.",
      );
    case "unconfigured":
      return refused(501, "App Store origin is not configured for this instance");
    case "unreachable":
      return refused(502, `Could not reach the App Store: ${result.message}`);
    case "rejected":
      return { status: "rejected", httpStatus: result.httpStatus, error: result.message };
  }
}

export interface PublishAppOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-upload hard timeout. */
  timeoutMs?: number;
}

export async function publishAppBundle(
  artifactRoot: string,
  expectedHash: string,
  opts: PublishAppOptions = {},
): Promise<PublishAppResult> {
  let actualHash: string;
  try {
    actualHash = await hashArtifact(artifactRoot);
  } catch {
    return { status: "artifact_missing" };
  }
  if (actualHash !== expectedHash) return { status: "artifact_drifted" };

  const token = await cloudBearer();
  if (!token) return { status: "no_token" };

  const origin = getRomeCloudOrigin();
  if (!origin) return { status: "unconfigured" };

  const bytes = await packBundle(artifactRoot);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const storeBytes = await packStoreSidecar(artifactRoot);

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const form = new FormData();
    form.set("bundle", new Blob([toBlobPart(bytes)], { type: "application/gzip" }), "bundle.tgz");
    if (storeBytes) {
      form.set(
        "store",
        new Blob([toBlobPart(storeBytes)], { type: "application/gzip" }),
        "rome_store.tgz",
      );
    }

    response = await fetchImpl(new URL("/api/store/publish", origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-bundle-sha256": hash,
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const message = controller.signal.aborted
      ? `Publish timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { status: "unreachable", message };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 201) {
    const payload = (await response.json()) as {
      listing: { id: string; handle: string; slug: string };
      version: {
        version: string;
        contentHash: string;
        sizeBytes: number;
        sourceAvailable?: unknown;
      };
      claimed: boolean;
    };
    log.info("published app bundle", {
      listingId: payload.listing.id,
      version: payload.version.version,
      bytes: payload.version.sizeBytes,
    });
    return {
      status: "ok",
      listing: payload.listing,
      version: {
        version: payload.version.version,
        contentHash: payload.version.contentHash,
        sizeBytes: payload.version.sizeBytes,
        sourceAvailable: payload.version.sourceAvailable === true,
      },
      claimed: payload.claimed,
    };
  }

  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : null;
  // The store's instance-auth sentinels mean the credential
  // is dead, not that this app was refused — surface them as their own state.
  if (code === "invalid_instance_token" || code === "instance_revoked") {
    log.warn("store refused instance credential during publish", { code });
    return { status: "auth_invalid" };
  }
  const message = code ?? `App Store returned HTTP ${response.status}`;
  return { status: "rejected", httpStatus: response.status, message };
}

const STORE_CARD_PATH = "assets/store-card.png";
const ICON_MIMES: Record<string, OgIcon["mime"]> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Whether the listing names a key itself; an author's value always wins. A key
 * present with no value counts: appending a second one would make the document
 * reject as a duplicate mapping key, and it reads as "leave this alone".
 */
function declares(yamlText: string, key: "image" | "image_alt"): boolean {
  try {
    const doc = parseYaml(yamlText) as Record<string, unknown> | null;
    return doc !== null && typeof doc === "object" && key in doc;
  } catch {
    // Let the store report the malformed listing; never generate over it.
    return true;
  }
}

/**
 * Render the listing's share card from the packed manifest, with the template
 * instances draw for their own app links. The listing URL is unknown before
 * upload — the store assigns the handle and slug in its response — so the card
 * carries no link line.
 */
async function renderStoreCard(artifactRoot: string): Promise<{ png: Buffer; name: string }> {
  const manifestPath = join(artifactRoot, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  const name = manifest.name ?? manifest.id;

  let icon: OgIcon | null = null;
  if (manifest.icon) {
    const resolveRoot = manifest.appRoot
      ? resolvePathWithinBase(artifactRoot, manifest.appRoot, `appRoot for app "${manifest.id}"`)
      : artifactRoot;
    const iconPath = resolvePathWithinBase(
      resolveRoot,
      manifest.icon,
      `icon for app "${manifest.id}"`,
    );
    const mime = ICON_MIMES[extname(iconPath).toLowerCase()];
    if (mime && safeIsFile(iconPath)) icon = { mime, bytes: await readFile(iconPath) };
  }

  const png = await svgToPng(
    renderOgSvg({ name, description: manifest.tagline ?? null, link: null, icon }),
  );
  return { png, name };
}

/**
 * Copy the listing into a temp dir, add the generated card, and name it in the
 * manifest. The author's `.rome_store` is never written to, and appending the
 * keys to the raw text keeps their comments and ordering intact.
 */
async function stageSidecarWithCard(
  artifactRoot: string,
  storeRoot: string,
  yamlText: string | null,
): Promise<string> {
  const { png, name } = await renderStoreCard(artifactRoot);
  const staged = await mkdtemp(join(tmpdir(), "rome-store-sidecar-"));
  const stagedRoot = join(staged, ".rome_store");
  if (yamlText === null) {
    await mkdir(stagedRoot, { recursive: true });
  } else {
    await cp(storeRoot, stagedRoot, { recursive: true });
  }
  await mkdir(join(stagedRoot, "assets"), { recursive: true });
  await writeFile(join(stagedRoot, STORE_CARD_PATH), png);

  const alt = `${name} on the Rome App Store`;
  const generated =
    "\n# Added at publish time because this listing named no image.\n" +
    `image: ${STORE_CARD_PATH}\n` +
    (yamlText !== null && declares(yamlText, "image_alt")
      ? ""
      : `image_alt: ${JSON.stringify(alt)}\n`);
  // A listing invented here carries the image and nothing else: the store
  // already derives the title and description from the app manifest, and
  // overriding them would change listing copy as a side effect of a card.
  const head = yamlText === null ? "" : yamlText.replace(/\n*$/, "\n");
  await writeFile(join(stagedRoot, "rome_store.yaml"), head + generated.replace(/^\n/, ""));
  return staged;
}

/**
 * The `.rome_store` sidecar, uploaded beside the bundle and excluded from it.
 * A listing that names no `image` gets a generated share card, so an app
 * published from an instance does not fall back to the site-wide default.
 * Card failures are logged and the listing ships as authored.
 */
async function packStoreSidecar(artifactRoot: string): Promise<Buffer | null> {
  const sourceRoot = sourceRootForArtifactPath(artifactRoot);
  const authored = sourceRoot ? join(sourceRoot, ".rome_store") : join(artifactRoot, ".rome_store");
  const manifestPath = join(authored, "rome_store.yaml");
  const yamlText = existsSync(manifestPath) ? await readFile(manifestPath, "utf-8") : null;

  let storeRoot = authored;
  let staged: string | null = null;
  if (yamlText === null || !declares(yamlText, "image")) {
    try {
      staged = await stageSidecarWithCard(artifactRoot, authored, yamlText);
      storeRoot = join(staged, ".rome_store");
    } catch (err) {
      log.warn("store card generation failed; publishing the listing as authored", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (yamlText === null) return null;
    }
  }

  try {
    const chunks: Buffer[] = [];
    const stream = tarCreate(
      {
        gzip: true,
        cwd: dirname(storeRoot),
        portable: true,
        noMtime: true,
        filter: (entryPath) =>
          !entryPath.split("/").some((segment) => segment === "node_modules" || segment === ".git"),
      },
      [basename(storeRoot)],
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolvePromise());
      stream.on("error", rejectPromise);
    });
    return Buffer.concat(chunks);
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true });
  }
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
