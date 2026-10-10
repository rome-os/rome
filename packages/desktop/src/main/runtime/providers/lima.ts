import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../../logger";
import type {
  ProviderKind,
  RuntimeHostProbe,
  RuntimePullProgress,
  StartContainerArgs,
} from "../provider";
import { PullProgressParser } from "./lima-pull-parser";

const execFileAsync = promisify(execFile);
const log = createLogger("runtime:lima");

/**
 * Lima ships *bundled* with Rome — there is no "install Lima"
 * path for end users. The provider intentionally has no `installUrl` and
 * `openInstallPage` is a no-op. If the bundled binary is missing the app
 * itself is corrupt; we surface that as a hard failure asking the user
 * to reinstall Rome, never as a download CTA.
 */
const BUNDLE_CORRUPT_DETAIL =
  "Rome's bundled local runtime is missing. Reinstall Rome to restore it.";
const NERDCTL_NAMESPACE = "rome";
const CONTAINER_PLATFORM = "linux/arm64";
const INSTANCE_NAME = "rome";
const DEFAULT_CONTAINER_NAME = "rome-desktop";
const CONTAINER_TCP_PORT = 8080;
const ENV_HASH_LABEL = "rome.env-hash";

interface ContainerSummary {
  running: boolean;
  envHash: string | null;
  image: string;
}

const VM_START_TIMEOUT_MS = 6 * 60_000;
const COMMAND_PROBE_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const CONTAINER_RUN_TIMEOUT_MS = 5 * 60_000;
const SIGKILL_GRACE_MS = 5_000;
// Mirrors Docker Desktop quit-flow: SIGTERM the container, wait briefly for
// the in-container process to flush, then let limactl SIGKILL on the upper
// bound. CONTAINER_STOP_HARD_TIMEOUT_MS leaves headroom over the nerdctl
// grace period so spawnStreaming does not race nerdctl's own kill.
const CONTAINER_STOP_TIMEOUT_S = 10;
const CONTAINER_STOP_HARD_TIMEOUT_MS = (CONTAINER_STOP_TIMEOUT_S + 5) * 1_000;
const VM_STOP_TIMEOUT_MS = 60_000;
// How often we let a throttled pull-progress snapshot fire. 250ms is fast
// enough to feel live but slow enough to avoid swamping the IPC bridge when
// nerdctl spams updates (it ticks ~10–20 lines/sec at peak).
const PROGRESS_THROTTLE_MS = 250;

interface BundledLima {
  /** Absolute path to the bundled `limactl` binary. */
  binary: string;
  /** Absolute path to the bundled rome.yaml template. */
  template: string;
}

/**
 * Whether two image references name the same image.
 *
 * nerdctl reports the fully qualified form — `docker.io/yunfanye/rome:latest` —
 * while the app carries the short form it was configured with. Comparing the
 * raw strings never matches, which silently defeats container reuse.
 */
export function sameImageRef(a: string, b: string): boolean {
  return normalizeImageRef(a) === normalizeImageRef(b);
}

function normalizeImageRef(ref: string): string {
  const withoutRegistry = ref.replace(/^(index\.)?docker\.io\//, "");
  // Docker Hub's implicit namespace for single-name repositories.
  const withoutLibrary = withoutRegistry.replace(/^library\//, "");
  // An untagged ref means :latest, which is what nerdctl reports back. Only the
  // last path segment can carry the tag — a registry host may contain a colon
  // for its port.
  const lastSegment = withoutLibrary.slice(withoutLibrary.lastIndexOf("/") + 1);
  return lastSegment.includes(":") || lastSegment.includes("@")
    ? withoutLibrary
    : `${withoutLibrary}:latest`;
}

/**
 * Which of the tags nerdctl listed should be removed, keeping `keep`.
 *
 * Restricted to `keep`'s own repository: nothing else in that VM is ours.
 * Entries without a usable tag are skipped — `<none>` for dangling images and
 * an empty tag for anything pulled by digest are not refs `rmi` can act on.
 * Dangling images are reclaimed by `pruneDanglingImages`, which the upgrade
 * path calls; nothing prunes them on a launch.
 */
export function selectImagesToRemove(listed: string[], keep: string): string[] {
  const keepRepo = imageRepository(keep);
  const seen = new Set<string>();
  const remove: string[] = [];
  for (const raw of listed) {
    const ref = raw.trim();
    if (!ref || ref.includes("<none>") || ref.endsWith(":")) continue;
    if (imageRepository(ref) !== keepRepo) continue;
    if (sameImageRef(ref, keep)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    remove.push(ref);
  }
  return remove;
}

function imageRepository(ref: string): string {
  const normalized = normalizeImageRef(ref);
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  const colon = lastSegment.lastIndexOf(":");
  return colon === -1 ? normalized : normalized.slice(0, normalized.lastIndexOf("/") + 1 + colon);
}

function resolveBundledLima(): BundledLima | null {
  const candidateRoots: string[] = [];

  // Packaged: Rome.app/Contents/Resources/lima/
  if (process.resourcesPath) {
    candidateRoots.push(join(process.resourcesPath, "lima"));
  }

  // Dev: packages/desktop/lima/ (one or two parents up depending on whether
  // we're running from dist/main or src/main).
  candidateRoots.push(join(__dirname, "..", "..", "..", "lima"));
  candidateRoots.push(join(__dirname, "..", "..", "lima"));

  for (const root of candidateRoots) {
    const binary = join(root, "bin", "limactl");
    const template = join(root, "templates", "rome.yaml");
    if (existsSync(binary) && existsSync(template)) return { binary, template };
  }

  return null;
}

/**
 * Reads `images[0].location` from a Lima-shaped yaml file and returns its
 * basename, or null if the file is missing, unparseable, or has no image
 * entry. Used by startRuntime to detect a guest-image version bump between
 * the bundled template and the persisted instance config.
 */
function readImageBasename(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as
      | { images?: Array<{ location?: unknown }> }
      | null
      | undefined;
    const location = parsed?.images?.[0]?.location;
    if (typeof location !== "string" || location.length === 0) return null;
    return basename(location);
  } catch (error) {
    log.warn(
      `Could not read images[0].location from ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function resolveLimaHome(): string {
  // Live under ~/.rome-desktop alongside the rest of the desktop runtime
  // state (config.ts:resolveRuntimePaths). Keeps everything desktop owns
  // in one greppable, space-free, Electron-name-independent directory.
  // Lima's download cache (Ubuntu cloudimg, nerdctl) stays in macOS
  // standard ~/Library/Caches/lima/ — not controlled by LIMA_HOME.
  return join(homedir(), ".rome-desktop", "runtime", "lima");
}

export interface LimaProviderOptions {
  /**
   * Host filesystem path where Lima should publish the Rome container's
   * `:8080` listener as a Unix domain socket. Must match the socketPath
   * passed in StartContainerArgs.
   */
  hostSocketPath: string;
  containerName?: string;
}

export class LimaRuntimeProvider {
  readonly kind: ProviderKind = "lima";
  readonly containerName: string;
  private readonly hostSocketPath: string;
  private readonly limaHome: string;
  private bundled: BundledLima | null = null;

  constructor(options: LimaProviderOptions) {
    this.hostSocketPath = options.hostSocketPath;
    this.containerName = options.containerName ?? DEFAULT_CONTAINER_NAME;
    this.limaHome = resolveLimaHome();
  }

  async probeHost(): Promise<RuntimeHostProbe> {
    // The bundled limactl is part of the .app payload. A missing or
    // broken binary means the install itself is damaged — we never
    // send the user to a third-party download page.
    const bundled = this.getBundledLima();
    if (!bundled) throw new Error(BUNDLE_CORRUPT_DETAIL);

    const responsive = await this.commandSucceeds(bundled.binary, ["--version"]);
    if (!responsive) throw new Error(BUNDLE_CORRUPT_DETAIL);

    const status = await this.readInstanceStatus();
    return {
      runtimeInstalled: true,
      runtimeRunning: status === "Running",
      detail:
        status === "Running"
          ? "Local runtime is ready."
          : status === "Missing"
            ? "Local runtime is installed; the Rome VM has not been created yet."
            : `Local runtime is installed; the Rome VM is currently ${status.toLowerCase()}.`,
      installUrl: "",
    };
  }

  async startRuntime(): Promise<boolean> {
    mkdirSync(this.limaHome, { recursive: true });
    mkdirSync(dirname(this.hostSocketPath), { recursive: true });

    let status = await this.readInstanceStatus();
    // If the bundled template points
    // at a different qcow2 than the persisted instance was created from,
    // the user installed a newer desktop release that ships a newer image.
    // Lima will not re-base an existing VM onto a new disk image, so we
    // delete and let the Missing branch below re-create. Host-side state
    // (Rome home, env file, host socket) lives outside the VM and survives.
    if (status !== "Missing") {
      const desired = this.desiredImageBasename();
      const persisted = this.persistedImageBasename();
      if (desired && persisted && desired !== persisted) {
        log.warn(
          `Guest image drifted (yaml=${persisted}, desired=${desired}); ` +
            "deleting Rome VM to rebuild from the new image",
        );
        // Stop first — limactl delete refuses on a Running instance unless
        // --force is paired with a stop, and our --force path through
        // runIgnoreFailure swallows the diagnostic.
        await this.runIgnoreFailure(this.requireBundledLima().binary, [
          "stop",
          "--force",
          INSTANCE_NAME,
        ]);
        await this.runIgnoreFailure(this.requireBundledLima().binary, [
          "delete",
          "--force",
          INSTANCE_NAME,
        ]);
        status = "Missing";
      }
    }

    // The host socket override has to stick across account renames,
    // `~/Library` migrations, or future changes to how we derive the
    // path — otherwise the cached lima.yaml keeps the stale socket and
    // the loopback proxy times out without a visible cause. For
    // Missing/Stopped we always pass --set (Lima is idempotent on
    // unchanged values). For Running we check the persisted yaml first
    // and only stop+restart when the path actually drifted, to keep the
    // common no-op startup path fast.
    const hostSocketSet = `.portForwards[0].hostSocket = ${JSON.stringify(this.hostSocketPath)}`;
    // Lima does not expand `{{.Dir}}` (or any template variable) in
    // images[].location, so the rome.yaml value is a placeholder and we
    // must hand Lima the absolute path at start time. Resolving from
    // the bundled template's directory keeps this co-located with
    // whatever filename the desktop release shipped.
    const imageLocationSet = `.images[0].location = ${JSON.stringify(this.bundledImagePath())}`;
    try {
      if (status === "Missing") {
        await this.spawnStreaming(
          [
            "start",
            "--tty=false",
            "--name",
            INSTANCE_NAME,
            "--set",
            hostSocketSet,
            "--set",
            imageLocationSet,
            this.requireBundledLima().template,
          ],
          { timeoutMs: VM_START_TIMEOUT_MS },
        );
      } else if (status !== "Running") {
        // For an existing instance Lima already persisted images[0].location
        // (it stores the resolved absolute path in lima.yaml), so we don't
        // need to re-set it here — the drift check at the top of
        // startRuntime() would have rebuilt the VM if the bundled image
        // changed.
        await this.spawnStreaming(["start", "--tty=false", "--set", hostSocketSet, INSTANCE_NAME], {
          timeoutMs: VM_START_TIMEOUT_MS,
        });
      } else {
        const persisted = this.readPersistedHostSocket();
        if (persisted !== null && persisted !== this.hostSocketPath) {
          log.warn(
            `Lima hostSocket drifted (yaml=${persisted}, desired=${this.hostSocketPath}); ` +
              "restarting VM to reapply the override",
          );
          await this.spawnStreaming(["stop", INSTANCE_NAME], { timeoutMs: VM_STOP_TIMEOUT_MS });
          await this.spawnStreaming(
            ["start", "--tty=false", "--set", hostSocketSet, INSTANCE_NAME],
            { timeoutMs: VM_START_TIMEOUT_MS },
          );
        }
      }
    } catch (error) {
      log.error("limactl start failed", error);
      return false;
    }

    return (await this.readInstanceStatus()) === "Running";
  }

  /**
   * Returns the basename of the bundled template's `images[0].location`,
   * or null if the template is missing/unreadable/has no images block.
   * The basename is the stable identity — the directory portion contains
   * the {{.Dir}} expansion which differs between the template path inside
   * the .app and the resolved path Lima persists.
   */
  private desiredImageBasename(): string | null {
    const bundled = this.getBundledLima();
    if (!bundled) return null;
    return readImageBasename(bundled.template);
  }

  /**
   * Resolves the absolute path to the bundled qcow2 by joining the
   * template's directory with `../images/<basename>`. The bundled tree
   * inside the .app is laid out as `lima/templates/rome.yaml` +
   * `lima/images/<filename>.qcow2`, so the relative climb is fixed
   * regardless of where Rome.app lives on disk.
   */
  private bundledImagePath(): string {
    const bundled = this.requireBundledLima();
    const filename = readImageBasename(bundled.template);
    if (!filename) {
      throw new Error("Bundled rome.yaml has no images[0].location to resolve a guest disk from.");
    }
    return join(dirname(bundled.template), "..", "images", filename);
  }

  /**
   * Returns the basename of the persisted instance's `images[0].location`,
   * or null if the instance has not been created yet (the usual Missing
   * case) or the yaml is unreadable. Comparing this to
   * `desiredImageBasename()` is how startRuntime detects a guest-image
   * version bump.
   */
  private persistedImageBasename(): string | null {
    return readImageBasename(join(this.limaHome, INSTANCE_NAME, "lima.yaml"));
  }

  /**
   * Returns the first `portForwards[].hostSocket` from the persisted
   * lima.yaml of the Rome instance, or null if the file is missing,
   * unreadable, or has no hostSocket — all treated as "unknown, leave it
   * alone" by the caller. The Rome template defines exactly one
   * portForward and that's where we override hostSocket, so the first
   * entry is the right one to compare against.
   */
  private readPersistedHostSocket(): string | null {
    const configPath = join(this.limaHome, INSTANCE_NAME, "lima.yaml");
    if (!existsSync(configPath)) return null;
    try {
      const parsed = parseYaml(readFileSync(configPath, "utf8")) as
        | { portForwards?: Array<{ hostSocket?: unknown }> }
        | null
        | undefined;
      const value = parsed?.portForwards?.[0]?.hostSocket;
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch (error) {
      log.warn(
        `Could not read persisted lima.yaml at ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async openInstallPage(): Promise<void> {
    // The runtime is bundled. There is no install page to open — the only
    // remediation for a missing binary is to reinstall Rome.
  }

  async imageExists(image: string): Promise<boolean> {
    return this.commandSucceeds(this.requireBundledLima().binary, [
      "shell",
      "--workdir=/",
      INSTANCE_NAME,
      "sudo",
      "nerdctl",
      "--namespace",
      NERDCTL_NAMESPACE,
      "image",
      "inspect",
      image,
    ]);
  }

  /**
   * Returns the digest of the locally-stored image (the same value that
   * would appear after `@` in `nerdctl image inspect`'s RepoDigests), or
   * null when the image is not present locally or has no stored digest.
   * Used by the image updater to compare against the registry's current
   * digest for the tag.
   */
  async getLocalImageDigest(image: string): Promise<string | null> {
    const bundled = this.getBundledLima();
    if (!bundled) return null;
    try {
      const { stdout } = await execFileAsync(
        bundled.binary,
        [
          "shell",
          "--workdir=/",
          INSTANCE_NAME,
          "sudo",
          "nerdctl",
          "--namespace",
          NERDCTL_NAMESPACE,
          "image",
          "inspect",
          image,
          "--format",
          `{{range .RepoDigests}}{{println .}}{{end}}`,
        ],
        { timeout: COMMAND_PROBE_TIMEOUT_MS, env: this.limaEnv() },
      );
      // RepoDigests entries are `name@sha256:...`. For a multi-tag image we
      // take the first one — they all share the same digest in practice.
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const at = line.lastIndexOf("@");
        if (at === -1) continue;
        return line.slice(at + 1);
      }
      return null;
    } catch {
      return null;
    }
  }

  async pullImage(
    image: string,
    onProgress: (progress: RuntimePullProgress) => void,
  ): Promise<void> {
    onProgress({
      phase: "downloading",
      percent: null,
      status: "Downloading Rome runtime image",
      currentBytes: 0,
      totalBytes: 0,
      layersCompleted: 0,
      layersTotal: 0,
    });

    // Docker Hub via CloudFront occasionally drops the connection mid-blob
    // (EOF on the registry-v2 GET). nerdctl does not auto-retry; containerd's
    // content store does keep partial layers, so re-running pull resumes
    // from where we left off. Three attempts with backoff is enough for
    // transient flakes without dragging the failure phase out.
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.spawnPullWithProgress(
          [
            "shell",
            "--workdir=/",
            INSTANCE_NAME,
            "sudo",
            "nerdctl",
            "--namespace",
            NERDCTL_NAMESPACE,
            "pull",
            "--platform",
            CONTAINER_PLATFORM,
            image,
          ],
          { timeoutMs: PULL_TIMEOUT_MS, onProgress },
        );
        onProgress({
          phase: "done",
          percent: 100,
          status: "Rome runtime image ready",
          currentBytes: 0,
          totalBytes: 0,
          layersCompleted: 0,
          layersTotal: 0,
        });
        return;
      } catch (error) {
        lastError = error;
        log.warn(
          `nerdctl pull attempt ${attempt}/${maxAttempts} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (attempt < maxAttempts) {
          onProgress({
            phase: "downloading",
            percent: null,
            status: `Network error — retrying (${attempt}/${maxAttempts})`,
            currentBytes: 0,
            totalBytes: 0,
            layersCompleted: 0,
            layersTotal: 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        }
      }
    }
    throw new Error(
      "Could not download the Rome runtime image. Check your internet " +
        "connection (or TUN proxy settings) and try again. " +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * Best-effort removal of dangling images left behind after an image
   * upgrade. Pulling a new `:tag` over an existing tag in nerdctl leaves
   * the previous image as a dangling `<none>:<none>` entry whose layers
   * stay in the content store; over many upgrades this fills the guest
   * VM disk. Removes only unreferenced images and never throws: pruning is
   * a hygiene step that should not surface as an upgrade failure.
   */
  async pruneDanglingImages(): Promise<void> {
    const bundled = this.getBundledLima();
    if (!bundled) return;
    try {
      await execFileAsync(
        bundled.binary,
        [
          "shell",
          "--workdir=/",
          INSTANCE_NAME,
          "sudo",
          "nerdctl",
          "--namespace",
          NERDCTL_NAMESPACE,
          "image",
          "prune",
          "--force",
        ],
        { timeout: COMMAND_PROBE_TIMEOUT_MS, env: this.limaEnv() },
      );
    } catch (err) {
      log.warn(`nerdctl image prune failed (non-fatal): ${String(err)}`);
    }
  }

  /**
   * Best-effort removal of the Rome image's other tags, keeping `keep`.
   *
   * Pinned releases each hold their own tag, so nothing ever becomes dangling
   * and `pruneDanglingImages` reclaims nothing — every app update leaves a
   * multi-gigabyte image behind until the guest disk fills and the next pull
   * fails. Touches only `keep`'s repository and never throws: reclaiming
   * space is hygiene and cannot be allowed to fail a launch.
   */
  async removeOtherImageTags(keep: string): Promise<void> {
    const bundled = this.getBundledLima();
    if (!bundled) return;
    const nerdctl = [
      "shell",
      "--workdir=/",
      INSTANCE_NAME,
      "sudo",
      "nerdctl",
      "--namespace",
      NERDCTL_NAMESPACE,
    ];
    let listed: string[];
    try {
      const { stdout } = await execFileAsync(
        bundled.binary,
        [...nerdctl, "images", "--format", "{{.Repository}}:{{.Tag}}"],
        { timeout: COMMAND_PROBE_TIMEOUT_MS, env: this.limaEnv() },
      );
      listed = stdout.split("\n");
    } catch (err) {
      log.warn(`nerdctl images failed, keeping every tag (non-fatal): ${String(err)}`);
      return;
    }

    // One at a time: nerdctl stops at the first failure when given several
    // refs, and the image backing the running container legitimately refuses.
    for (const ref of selectImagesToRemove(listed, keep)) {
      try {
        await execFileAsync(bundled.binary, [...nerdctl, "rmi", ref], {
          timeout: COMMAND_PROBE_TIMEOUT_MS,
          env: this.limaEnv(),
        });
        log.info(`Reclaimed ${ref}`);
      } catch (err) {
        log.warn(`Could not remove ${ref} (non-fatal): ${String(err)}`);
      }
    }
  }

  async startContainer(args: StartContainerArgs): Promise<void> {
    const bundled = this.requireBundledLima();
    mkdirSync(dirname(args.envFile), { recursive: true });
    mkdirSync(dirname(args.socketPath), { recursive: true });

    if (args.socketPath !== this.hostSocketPath) {
      throw new Error(
        `Lima provider configured with hostSocketPath=${this.hostSocketPath}, ` +
          `but startContainer was called with socketPath=${args.socketPath}. ` +
          `Recreate the runtime to change the published socket path.`,
      );
    }

    // Hash both the env file *and* the bind-mount target so changing
    // homeDir forces a recreate. nerdctl bakes -v paths into container
    // config at run time; nerdctl start can't re-bind them.
    const envHash = createHash("sha256")
      .update(readFileSync(args.envFile))
      .update("\n--home-dir=")
      .update(args.homeDir)
      .digest("hex");
    const existing = args.forceRecreate ? null : await this.inspectContainer();

    if (existing && sameImageRef(existing.image, args.image) && existing.envHash === envHash) {
      if (existing.running) {
        log.info("Rome container already running with matching config; reusing");
        return;
      }
      log.info("Rome container exists with matching config; starting in place");
      // The container is stopped — that is this branch's condition — so any
      // socket file left on the host is stale, and Lima has to be free to
      // publish a fresh one. The recreate path below wipes it for the same
      // reason; this branch reached it only once inspectContainer started
      // working, which is why it was missing.
      rmSync(args.socketPath, { force: true });
      await this.spawnStreaming(
        [
          "shell",
          "--workdir=/",
          INSTANCE_NAME,
          "sudo",
          "nerdctl",
          "--namespace",
          NERDCTL_NAMESPACE,
          "start",
          this.containerName,
        ],
        { timeoutMs: CONTAINER_RUN_TIMEOUT_MS },
      );
      return;
    }

    if (existing) {
      log.info("Rome container config differs (image or env changed); recreating from scratch");
    }

    // Wipe any stale socket file the previous container left behind so Lima's
    // port-forward can re-publish a fresh one. Safe here and in the
    // start-in-place branch above; the only path that must not touch it is the
    // reuse-a-running-container branch, where the socket is live.
    rmSync(args.socketPath, { force: true });

    await this.runIgnoreFailure(bundled.binary, [
      "shell",
      "--workdir=/",
      INSTANCE_NAME,
      "sudo",
      "nerdctl",
      "--namespace",
      NERDCTL_NAMESPACE,
      "stop",
      this.containerName,
    ]);
    await this.runIgnoreFailure(bundled.binary, [
      "shell",
      "--workdir=/",
      INSTANCE_NAME,
      "sudo",
      "nerdctl",
      "--namespace",
      NERDCTL_NAMESPACE,
      "rm",
      "--force",
      this.containerName,
    ]);

    const runArgs = [
      "shell",
      "--workdir=/",
      INSTANCE_NAME,
      "sudo",
      "nerdctl",
      "--namespace",
      NERDCTL_NAMESPACE,
      "run",
      "-d",
      "--name",
      this.containerName,
      "--platform",
      CONTAINER_PLATFORM,
      // Bind the container directly into the VM's network namespace
      // instead of `-p 8080:8080`. With system-mode containerd (rome.yaml
      // sets `containerd.user: false`), `-p` is implemented via iptables
      // DNAT rather than a userspace listener — Lima's guest agent only
      // forwards ports that show up as actual LISTEN sockets in `ss`,
      // so a DNAT-only rule never causes the host socket to publish and
      // the loopback proxy can't reach Rome. `--net host` puts Rome's
      // `0.0.0.0:8080` listener directly in the VM net ns where Lima
      // sees it. Caddy / daemon / api listeners inside the container
      // share the VM net ns too but only the port declared in
      // rome.yaml's portForwards (8080) is exposed to the macOS host.
      "--net",
      "host",
      "-v",
      `${args.homeDir}:/home/rome`,
      "--label",
      `${ENV_HASH_LABEL}=${envHash}`,
      "--env-file",
      args.envFile,
      "-e",
      "NODE_ENV=production",
      "-e",
      "WEB_HOST=0.0.0.0",
      "-e",
      "ROME_CHROME_DISABLE_SANDBOX=1",
      args.image,
    ];

    await this.spawnStreaming(runArgs, { timeoutMs: CONTAINER_RUN_TIMEOUT_MS });
  }

  /**
   * Best-effort graceful stop of the Rome container. Returns once the
   * container is no longer running, or after the internal grace period —
   * never throws. Called during quit so the Rome process inside the VM gets
   * a SIGTERM and a chance to flush state before the VM is torn down.
   */
  async stopContainer(): Promise<void> {
    const bundled = this.getBundledLima();
    if (!bundled) return;

    // Skip if the VM is not running — there is nothing to talk to and
    // `limactl shell` would block trying to start it.
    const vmStatus = await this.readInstanceStatus();
    if (vmStatus !== "Running") return;

    const existing = await this.inspectContainer();
    if (!existing || !existing.running) return;

    log.info(`Stopping Rome container (graceful SIGTERM, ${CONTAINER_STOP_TIMEOUT_S}s grace)`);
    try {
      await this.spawnStreaming(
        [
          "shell",
          "--workdir=/",
          INSTANCE_NAME,
          "sudo",
          "nerdctl",
          "--namespace",
          NERDCTL_NAMESPACE,
          "stop",
          "--time",
          String(CONTAINER_STOP_TIMEOUT_S),
          this.containerName,
        ],
        { timeoutMs: CONTAINER_STOP_HARD_TIMEOUT_MS },
      );
    } catch (error) {
      // Quit-path: log and continue. The next stopRuntime() will yank the
      // whole VM, which kills any container that did not honor SIGTERM.
      log.warn(
        `nerdctl stop failed; VM stop will take it down: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Best-effort stop of the Lima VM. Returns once it reports stopped, or
   * after the internal grace period — never throws. Called during quit after
   * stopContainer.
   */
  async stopRuntime(): Promise<void> {
    const bundled = this.getBundledLima();
    if (!bundled) return;

    const status = await this.readInstanceStatus();
    if (status === "Missing" || status === "Stopped") return;

    log.info(`Stopping Lima VM (status=${status})`);
    try {
      await this.spawnStreaming(["stop", INSTANCE_NAME], { timeoutMs: VM_STOP_TIMEOUT_MS });
    } catch (error) {
      log.warn(
        `limactl stop failed; escalating to --force: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // `limactl stop --force` skips the graceful shutdown and yanks the
      // qemu/vz process directly. Last resort during the quit flow.
      try {
        await this.spawnStreaming(["stop", "--force", INSTANCE_NAME], {
          timeoutMs: VM_STOP_TIMEOUT_MS,
        });
      } catch (forceError) {
        log.error("limactl stop --force also failed", forceError);
      }
    }
  }

  /**
   * Returns the current state of the named container or null if it does not
   * exist. The image/envHash pair drives the reuse decision in
   * startContainer — if either differs from the desired config we recreate.
   */
  private async inspectContainer(): Promise<ContainerSummary | null> {
    const bundled = this.getBundledLima();
    if (!bundled) return null;
    try {
      const { stdout } = await execFileAsync(
        bundled.binary,
        [
          "shell",
          "--workdir=/",
          INSTANCE_NAME,
          "sudo",
          "nerdctl",
          "--namespace",
          NERDCTL_NAMESPACE,
          "container",
          "inspect",
          this.containerName,
          "--format",
          // `.Image`, not `.Config.Image`: nerdctl's inspect has no Image key
          // under Config, and asking for one is a template error that rejects
          // this whole call. That failure was invisible — the catch below turns
          // it into "no container", so every launch recreated from scratch and
          // the reuse path never ran.
          `{{.State.Status}}|{{index .Config.Labels "${ENV_HASH_LABEL}"}}|{{.Image}}`,
        ],
        { timeout: COMMAND_PROBE_TIMEOUT_MS, env: this.limaEnv() },
      );
      const line = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (!line) return null;
      const [status = "", envHash = "", image = ""] = line.split("|");
      return {
        running: status.toLowerCase() === "running",
        envHash: envHash.length > 0 ? envHash : null,
        image,
      };
    } catch {
      // `nerdctl inspect` exits nonzero when the container does not exist.
      return null;
    }
  }

  async collectDiagnostics(): Promise<Record<string, string>> {
    const bundled = this.getBundledLima();
    if (!bundled) return { limactl: "bundled runtime not found" };

    const diagnostics: Record<string, string> = {};
    for (const args of [
      ["--version"],
      ["list", "--format=json"],
      [
        "shell",
        "--workdir=/",
        INSTANCE_NAME,
        "sudo",
        "nerdctl",
        "--namespace",
        NERDCTL_NAMESPACE,
        "ps",
        "--all",
      ],
      [
        "shell",
        "--workdir=/",
        INSTANCE_NAME,
        "sudo",
        "nerdctl",
        "--namespace",
        NERDCTL_NAMESPACE,
        "image",
        "ls",
      ],
      [
        "shell",
        "--workdir=/",
        INSTANCE_NAME,
        "sudo",
        "nerdctl",
        "--namespace",
        NERDCTL_NAMESPACE,
        "logs",
        "--tail",
        "200",
        this.containerName,
      ],
    ]) {
      diagnostics[args.join(" ")] = await this.captureOutput(bundled.binary, args);
    }
    return diagnostics;
  }

  /**
   * Returns the lifecycle status of the Rome Lima instance. "Missing" means
   * the instance has never been created; anything else is whatever `limactl
   * list` reports verbatim (Running, Stopped, Broken, …).
   */
  private async readInstanceStatus(): Promise<string> {
    const bundled = this.getBundledLima();
    if (!bundled) return "Missing";
    try {
      const { stdout } = await execFileAsync(
        bundled.binary,
        ["list", "--format=json", INSTANCE_NAME],
        { timeout: COMMAND_PROBE_TIMEOUT_MS, env: this.limaEnv() },
      );
      // `limactl list` emits one JSON object per line. With a name filter it
      // emits zero or one line.
      const line = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (!line) return "Missing";
      const parsed = JSON.parse(line) as { status?: string };
      return parsed.status ?? "Unknown";
    } catch {
      return "Missing";
    }
  }

  private limaEnv(): NodeJS.ProcessEnv {
    return { ...process.env, LIMA_HOME: this.limaHome };
  }

  /**
   * Streaming wrapper for long-running commands. Pipes stdout+stderr line
   * by line into the logger so output is never retained in memory — `limactl
   * start` and `nerdctl pull` can emit tens of MB of progress over several
   * minutes, well past `execFile`'s default 1 MiB buffer. Resolves on
   * `exit 0`, rejects on any other terminal state.
   */
  private spawnStreaming(args: string[], opts: { timeoutMs: number }): Promise<void> {
    const bundled = this.requireBundledLima();
    return new Promise((resolve, reject) => {
      const child = spawn(bundled.binary, args, { env: this.limaEnv() });
      const tag = `lima ${args[0] ?? ""}`.trim();

      const lineStream = (stream: NodeJS.ReadableStream, level: "info" | "error") => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line) log[level](`[${tag}] ${line}`);
          }
        });
        stream.on("end", () => {
          if (buf) log[level](`[${tag}] ${buf}`);
        });
      };
      lineStream(child.stdout, "info");
      lineStream(child.stderr, "info"); // Lima logs almost everything to stderr

      // SIGTERM with a SIGKILL escalation. `limactl` is a Go binary that
      // can sit in syscalls (VM kernel boot, large nerdctl pulls) where
      // SIGTERM is not promptly observed, which would otherwise leave an
      // orphan process burning CPU / disk after the parent has moved on.
      let killTimer: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, SIGKILL_GRACE_MS);
        reject(new Error(`${tag} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);

      const clearTimers = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      child.on("error", (err) => {
        clearTimers();
        reject(err);
      });
      child.on("exit", (code, signal) => {
        clearTimers();
        if (code === 0) resolve();
        else reject(new Error(`${tag} exited with code=${code} signal=${signal}`));
      });
    });
  }

  /**
   * Streaming wrapper specialized for `nerdctl pull`. Parses each line of
   * containerd's plain-mode progress output into structured layer state and
   * surfaces it via onProgress (throttled). Only layer status transitions
   * are logged — repeated byte-level snapshots are dropped to keep the debug
   * log readable across multi-minute image pulls.
   */
  private spawnPullWithProgress(
    args: string[],
    opts: {
      timeoutMs: number;
      onProgress: (progress: RuntimePullProgress) => void;
    },
  ): Promise<void> {
    const bundled = this.requireBundledLima();
    return new Promise((resolve, reject) => {
      const child = spawn(bundled.binary, args, { env: this.limaEnv() });
      const tag = `lima ${args[0] ?? ""}`.trim();
      const parser = new PullProgressParser();
      let lastEmit = 0;
      let pendingTimer: NodeJS.Timeout | null = null;
      let dirty = false;

      const flushProgress = (): void => {
        pendingTimer = null;
        if (!dirty) return;
        dirty = false;
        lastEmit = Date.now();
        try {
          opts.onProgress(parser.snapshot());
        } catch (err) {
          log.warn(`pull progress callback threw: ${err instanceof Error ? err.message : err}`);
        }
      };
      const scheduleProgress = (force: boolean): void => {
        dirty = true;
        if (force) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          flushProgress();
          return;
        }
        if (pendingTimer) return;
        const wait = Math.max(0, PROGRESS_THROTTLE_MS - (Date.now() - lastEmit));
        pendingTimer = setTimeout(flushProgress, wait);
      };

      const lineStream = (stream: NodeJS.ReadableStream) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (!line) continue;
            const transition = parser.ingest(line);
            if (transition) {
              log.info(
                `[${tag}] ${transition.ref}: ${transition.from ?? "(new)"} → ${transition.to}`,
              );
              scheduleProgress(true);
            } else {
              scheduleProgress(false);
            }
          }
        });
        stream.on("end", () => {
          if (buf) {
            const transition = parser.ingest(buf);
            if (transition) {
              log.info(
                `[${tag}] ${transition.ref}: ${transition.from ?? "(new)"} → ${transition.to}`,
              );
            }
          }
        });
      };
      lineStream(child.stdout);
      lineStream(child.stderr);

      let killTimer: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, SIGKILL_GRACE_MS);
        // Cancel any pending throttled flush — otherwise a stale snapshot
        // can fire after reject() and clobber the "retrying" UI state that
        // pullImage sets in its catch handler before the next attempt.
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        dirty = false;
        reject(new Error(`${tag} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);

      const clearTimers = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      };
      child.on("error", (err) => {
        clearTimers();
        reject(err);
      });
      child.on("exit", (code, signal) => {
        clearTimers();
        if (code === 0) {
          // Pull command exited cleanly — guarantee a final 100% / done
          // snapshot regardless of which intermediate state the parser was
          // in (some pulls finish without an explicit unpacking line).
          parser.markComplete();
          try {
            opts.onProgress(parser.snapshot());
          } catch {
            // Ignored — pull is over.
          }
          resolve();
          return;
        }
        // On failure, still flush any pending progress so the UI isn't
        // stuck on an older snapshot while we surface the retry.
        if (dirty) {
          dirty = false;
          try {
            opts.onProgress(parser.snapshot());
          } catch {
            // Ignored — pull is over.
          }
        }
        reject(new Error(`${tag} exited with code=${code} signal=${signal}`));
      });
    });
  }

  private async commandSucceeds(command: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync(command, args, {
        timeout: COMMAND_PROBE_TIMEOUT_MS,
        env: this.limaEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async runIgnoreFailure(command: string, args: string[]): Promise<void> {
    try {
      await execFileAsync(command, args, {
        timeout: COMMAND_PROBE_TIMEOUT_MS,
        env: this.limaEnv(),
      });
    } catch {
      // Expected when the container does not exist yet.
    }
  }

  private async captureOutput(command: string, args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: COMMAND_PROBE_TIMEOUT_MS,
        env: this.limaEnv(),
      });
      return (stdout || stderr || "").toString();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private getBundledLima(): BundledLima | null {
    if (this.bundled) return this.bundled;
    this.bundled = resolveBundledLima();
    return this.bundled;
  }

  private requireBundledLima(): BundledLima {
    const bundled = this.getBundledLima();
    if (!bundled) {
      throw new Error("Rome's bundled local runtime is missing.");
    }
    return bundled;
  }
}
