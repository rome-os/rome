import { BrowserWindow } from "electron";
import { handleTrusted } from "../ipc-trust";
import { eq } from "drizzle-orm";
import { request as httpsRequest } from "https";
import { getDb } from "../db/database";
import { settings } from "../db/schema";
import { createLogger } from "../logger";
import type { RuntimeManager } from "./manager";

const FIRST_CHECK_DELAY_MS = 90 * 1000;
const CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;
const AUTO_UPDATE_ENABLED_KEY = "rome.image.auto_update";
const HEAD_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 15_000;

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export type ImageUpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "updating"
  | "error"
  | "unsupported";

export interface ImageUpdateStatus {
  state: ImageUpdateState;
  image: string;
  currentDigest: string | null;
  latestDigest: string | null;
  autoUpdateEnabled: boolean;
  lastCheckedAt: string | null;
  message: string;
  error: string | null;
}

interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

const log = createLogger("image-updater");

class RomeImageUpdater {
  private started = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private firstCheckTimer: NodeJS.Timeout | null = null;
  private status: ImageUpdateStatus;

  constructor(private readonly runtime: RuntimeManager) {
    this.status = {
      state: "idle",
      image: runtime.getImage(),
      currentDigest: null,
      latestDigest: null,
      autoUpdateEnabled: true,
      lastCheckedAt: null,
      message: "Update checks are ready.",
      error: null,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.registerIpcHandlers();
    this.refreshAutoUpdateSetting();

    // Trigger an initial digest read so the UI shows the current pinned
    // digest even before the first network check completes.
    void this.refreshCurrentDigest();

    this.checkTimer = setInterval(() => {
      void this.checkForUpdate("automatic");
    }, CHECK_INTERVAL_MS);

    this.firstCheckTimer = setTimeout(() => {
      this.firstCheckTimer = null;
      void this.checkForUpdate("automatic");
    }, FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.firstCheckTimer) {
      clearTimeout(this.firstCheckTimer);
      this.firstCheckTimer = null;
    }
  }

  getStatus(): ImageUpdateStatus {
    return { ...this.status };
  }

  async checkForUpdate(source: "manual" | "automatic" = "manual"): Promise<ImageUpdateStatus> {
    this.refreshAutoUpdateSetting();

    if (source === "automatic" && !this.status.autoUpdateEnabled) {
      return this.getStatus();
    }
    if (this.status.state === "updating" || this.status.state === "checking") {
      return this.getStatus();
    }

    const image = this.runtime.getImage();
    const ref = parseImageRef(image);
    if (!ref) {
      return this.setStatus({
        state: "unsupported",
        image,
        message:
          "Image is pinned to a digest or custom registry path; automatic update checks are disabled.",
        error: null,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    this.setStatus({
      state: "checking",
      image,
      message: "Checking the registry for a newer Rome image…",
      error: null,
    });

    try {
      const [currentDigest, latestDigest] = await Promise.all([
        this.runtime.getLocalImageDigest(),
        fetchRegistryDigest(ref),
      ]);

      const checkedAt = new Date().toISOString();

      if (!latestDigest) {
        return this.setStatus({
          state: "error",
          image,
          currentDigest,
          message: "Could not read the latest image digest from the registry.",
          error: "Registry did not return a Docker-Content-Digest header.",
          lastCheckedAt: checkedAt,
        });
      }

      if (!currentDigest) {
        return this.setStatus({
          state: "available",
          image,
          currentDigest: null,
          latestDigest,
          message: "Rome image has not been downloaded yet.",
          error: null,
          lastCheckedAt: checkedAt,
        });
      }

      if (digestsEqual(currentDigest, latestDigest)) {
        return this.setStatus({
          state: "up-to-date",
          image,
          currentDigest,
          latestDigest,
          message: "Your Rome image is up to date.",
          error: null,
          lastCheckedAt: checkedAt,
        });
      }

      return this.setStatus({
        state: "available",
        image,
        currentDigest,
        latestDigest,
        message: "A newer Rome image is available.",
        error: null,
        lastCheckedAt: checkedAt,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async applyUpdate(): Promise<ImageUpdateStatus> {
    if (this.status.state === "updating") return this.getStatus();

    const before = this.status;
    this.setStatus({
      state: "updating",
      message: "Updating the Rome image…",
      error: null,
    });
    try {
      await this.runtime.upgradeRuntime();
      // upgradeRuntime swallows its own failures (it sets a "failed"
      // runtime phase instead of throwing). Inspect the runtime state
      // before declaring success so a broken pull / recreate is not
      // hidden behind a fresh "up-to-date" image badge.
      const runtimeStatus = this.runtime.getStatus();
      if (runtimeStatus.phase !== "ready") {
        return this.setStatus({
          state: "error",
          image: this.runtime.getImage(),
          message: "Rome image update did not finish — the runtime is not ready.",
          error: runtimeStatus.lastError ?? `Runtime phase: ${runtimeStatus.phase}`,
          lastCheckedAt: new Date().toISOString(),
        });
      }
      const currentDigest = await this.runtime.getLocalImageDigest();
      const latestDigest = before.latestDigest;
      const upToDate =
        !!currentDigest && !!latestDigest && digestsEqual(currentDigest, latestDigest);
      return this.setStatus({
        state: upToDate ? "up-to-date" : "available",
        image: this.runtime.getImage(),
        currentDigest,
        latestDigest: latestDigest ?? currentDigest,
        message: upToDate
          ? "Rome image is up to date."
          : "Rome image updated; another newer version may still be available.",
        error: null,
        lastCheckedAt: new Date().toISOString(),
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async setAutoUpdateEnabled(enabled: boolean): Promise<ImageUpdateStatus> {
    const now = new Date().toISOString();
    getDb()
      .insert(settings)
      .values({
        key: AUTO_UPDATE_ENABLED_KEY,
        value: enabled ? "true" : "false",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: enabled ? "true" : "false", updatedAt: now },
      })
      .run();

    this.setStatus({
      autoUpdateEnabled: enabled,
      message: enabled
        ? "Automatic Rome image updates are on."
        : "Automatic Rome image updates are off.",
      error: null,
    });

    if (enabled) void this.checkForUpdate("automatic");
    return this.getStatus();
  }

  private async refreshCurrentDigest(): Promise<void> {
    try {
      const digest = await this.runtime.getLocalImageDigest();
      if (digest) {
        this.setStatus({ currentDigest: digest });
      }
    } catch (err) {
      log.warn(`Failed to read local image digest (${String(err)})`);
    }
  }

  private registerIpcHandlers(): void {
    handleTrusted("rome-image:getStatus", () => this.getStatus());
    handleTrusted("rome-image:check", () => this.checkForUpdate("manual"));
    handleTrusted("rome-image:apply", () => this.applyUpdate());
    handleTrusted("rome-image:setAutoUpdateEnabled", (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      return this.setAutoUpdateEnabled(enabled);
    });
  }

  private refreshAutoUpdateSetting(): boolean {
    try {
      const row = getDb()
        .select()
        .from(settings)
        .where(eq(settings.key, AUTO_UPDATE_ENABLED_KEY))
        .get();
      const enabled = row?.value == null ? true : row.value !== "false";
      this.status = { ...this.status, autoUpdateEnabled: enabled };
      return enabled;
    } catch (err) {
      log.warn(`Failed to read image auto-update setting (${String(err)})`);
      this.status = { ...this.status, autoUpdateEnabled: true };
      return true;
    }
  }

  private handleError(err: unknown): ImageUpdateStatus {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Image update flow failed", err);
    return this.setStatus({
      state: "error",
      message: "Rome image update check failed. Rome will try again later.",
      error: message,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  private setStatus(patch: Partial<ImageUpdateStatus>): ImageUpdateStatus {
    this.status = {
      ...this.status,
      ...patch,
      image: patch.image ?? this.status.image,
    };
    this.broadcast();
    return this.getStatus();
  }

  private broadcast(): void {
    const status = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("rome-image:status", status);
      }
    }
  }
}

export type { RomeImageUpdater };

export function createRomeImageUpdater(runtime: RuntimeManager): RomeImageUpdater {
  return new RomeImageUpdater(runtime);
}

function digestsEqual(a: string, b: string): boolean {
  return normalizeDigest(a) === normalizeDigest(b);
}

function normalizeDigest(digest: string): string {
  // Strip a leading `name@` if present. Compare on the algo:hex portion.
  const at = digest.lastIndexOf("@");
  return at === -1 ? digest : digest.slice(at + 1);
}

/**
 * Parse a container image reference into registry/repo/tag pieces. Returns
 * null for inputs we don't support (digest-pinned, malformed). Mirrors the
 * subset of containers/image's parsing we need: defaults to docker.io,
 * prefixes `library/` for single-name Docker Hub repos.
 */
export function parseImageRef(image: string): ImageRef | null {
  if (!image || image.includes("@")) return null;

  let remainder = image;
  let registry = "docker.io";

  const firstSlash = remainder.indexOf("/");
  if (firstSlash !== -1) {
    const head = remainder.slice(0, firstSlash);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = head;
      remainder = remainder.slice(firstSlash + 1);
    }
  }

  let tag = "latest";
  const colon = remainder.lastIndexOf(":");
  const slash = remainder.lastIndexOf("/");
  if (colon !== -1 && colon > slash) {
    tag = remainder.slice(colon + 1);
    remainder = remainder.slice(0, colon);
  }

  if (!remainder) return null;

  let repository = remainder;
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  return { registry, repository, tag };
}

interface RegistryEndpoint {
  /** Hostname for the registry pull API (no port, no scheme). */
  host: string;
  /** TCP port. Defaults to 443. */
  port: number;
}

export function registryEndpoint(registry: string): RegistryEndpoint {
  // Docker Hub's pull endpoint is registry-1.docker.io, not docker.io. Other
  // registries use their own hostname directly. Honor an explicit :port
  // suffix (e.g. private registries at "myregistry.example.com:5000") rather
  // than passing "host:port" as the connect host with port 443.
  if (registry === "docker.io") return { host: "registry-1.docker.io", port: 443 };
  const colon = registry.lastIndexOf(":");
  if (colon === -1) return { host: registry, port: 443 };
  const portStr = registry.slice(colon + 1);
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { host: registry, port: 443 };
  }
  return { host: registry.slice(0, colon), port };
}

async function fetchRegistryDigest(ref: ImageRef): Promise<string | null> {
  const endpoint = registryEndpoint(ref.registry);
  const path = `/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag)}`;

  let { digest, wwwAuthenticate, status } = await headManifest(endpoint, path, null);
  if (digest) return digest;

  if (status === 401 && wwwAuthenticate) {
    const token = await fetchBearerToken(wwwAuthenticate, endpoint.host);
    if (token) {
      ({ digest } = await headManifest(endpoint, path, token));
      if (digest) return digest;
    }
  }
  return null;
}

interface HeadManifestResult {
  digest: string | null;
  wwwAuthenticate: string | null;
  status: number;
}

function headManifest(
  endpoint: RegistryEndpoint,
  path: string,
  token: string | null,
): Promise<HeadManifestResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: MANIFEST_ACCEPT,
      "User-Agent": "rome-desktop",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = httpsRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path,
        method: "HEAD",
        headers,
        timeout: HEAD_TIMEOUT_MS,
      },
      (res) => {
        const digestHeader = res.headers["docker-content-digest"];
        const digest = Array.isArray(digestHeader) ? digestHeader[0] : digestHeader;
        const wwwAuth = res.headers["www-authenticate"];
        resolve({
          digest: digest ?? null,
          wwwAuthenticate: Array.isArray(wwwAuth) ? wwwAuth[0] : (wwwAuth ?? null),
          status: res.statusCode ?? 0,
        });
        res.resume();
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Registry HEAD request timed out"));
    });
    req.end();
  });
}

// Auth-token responses are JWTs in JSON — a few KB at most. Cap accumulation
// so a hostile (or compromised) auth endpoint can't stream an arbitrarily
// large body and exhaust the main-process heap.
const MAX_TOKEN_BODY_BYTES = 64 * 1024;

/**
 * Decide whether a Bearer realm URL is safe to follow. We require:
 *   - https scheme (TLS bound to a CA-issued cert),
 *   - hostname is the registry host itself, OR shares the registry's
 *     registrable suffix (eTLD+1) so docker.io → auth.docker.io works.
 * Otherwise an on-path attacker (or a compromised registry mirror) could
 * point us at any internal HTTPS service trusted by the system CA.
 */
export function isAllowedRealm(realm: string, registryHostname: string): boolean {
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const realmHost = url.hostname.toLowerCase();
  const registryHost = registryHostname.toLowerCase();
  if (realmHost === registryHost) return true;
  const suffix = registrableSuffix(registryHost);
  if (suffix && (realmHost === suffix || realmHost.endsWith(`.${suffix}`))) {
    return true;
  }
  return false;
}

/**
 * Approximate eTLD+1 for hostnames we expect to see in container-registry
 * land. We're not parsing the full PSL — just stripping a single subdomain
 * label when present (e.g. registry-1.docker.io → docker.io). IPs and
 * single-label hosts return null so the strict-equality check is the only
 * way past the realm validator.
 */
function registrableSuffix(host: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (host.includes(":")) return null;
  const parts = host.split(".");
  if (parts.length <= 2) return parts.length === 2 ? host : null;
  return parts.slice(-2).join(".");
}

/**
 * Parse a Bearer challenge header and exchange it for an anonymous token.
 * Example header:
 *   Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:yunfanye/rome:pull"
 */
async function fetchBearerToken(
  challenge: string,
  registryHostname: string,
): Promise<string | null> {
  if (!challenge.toLowerCase().startsWith("bearer ")) return null;

  const params = new Map<string, string>();
  const body = challenge.slice("bearer ".length);
  const regex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    params.set(match[1].toLowerCase(), match[2]);
  }

  const realm = params.get("realm");
  if (!realm) return null;
  if (!isAllowedRealm(realm, registryHostname)) {
    log.warn(
      `Refusing to follow Www-Authenticate realm "${realm}" for registry ${registryHostname}`,
    );
    return null;
  }
  const url = new URL(realm);
  const service = params.get("service");
  const scope = params.get("scope");
  if (service) url.searchParams.set("service", service);
  if (scope) url.searchParams.set("scope", scope);

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "rome-desktop" },
        timeout: TOKEN_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let aborted = false;
        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_TOKEN_BODY_BYTES) {
            aborted = true;
            req.destroy(new Error("Token response exceeded size limit"));
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            resolve(null);
            return;
          }
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              token?: string;
              access_token?: string;
            };
            resolve(payload.token ?? payload.access_token ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Token request timed out"));
    });
    req.end();
  });
}
