import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { request } from "http";
import { release } from "os";
import { shell } from "electron";
import { createLogger } from "../logger";
import {
  DEFAULT_RUNTIME_IMAGE,
  RUNTIME_IMAGE_IS_PINNED,
  generateRuntimeEnv,
  parseSimpleEnvFile,
  resolveProxyPort,
  resolveRuntimePaths,
  writeManagedRuntimeEnv,
  type RuntimePaths,
} from "./config";
import { startLocalProxy, type LocalProxy } from "./local-proxy";
import { LimaRuntimeProvider } from "./providers/lima";
import type {
  RuntimeAction,
  RuntimeHostProbe,
  RuntimePhase,
  RuntimePullProgress,
  RuntimeStatus,
} from "./provider";

const log = createLogger("runtime");

// Covers first boot only — the pull happens in `pulling_image` and is not on
// this clock. A container runs migrations and installs every first-party app
// artifact on 2 vCPUs, and does it slowest on a freshly unpacked image, where
// nothing is in the page cache yet. Observed:
//
//   50.2 – 144.2s   image already local (n=13)
//        226.6s     first boot of a just-pulled image
//        258.8s     slowest that still came up
//        301.0s     gave up one second past a 300s budget
//
// Set past the slowest observation rather than at it. Raising this does not
// help a slow download; that is a separate phase with its own behaviour.
const RUNTIME_HEALTH_TIMEOUT_MS = 600_000;
// Shorter than the budget above on purpose. This leg escapes a container that
// will never come up — an unclean VM shutdown can leave containerd reporting
// one as running with no live task behind it — so it recreates first and then
// waits on a fresh container, which is the 50–144s case. Matching 600s here
// would only stretch the worst case to 13 minutes of spinner for a runtime
// that is broken.
const RUNTIME_HEALTH_RETRY_TIMEOUT_MS = 180_000;
const RUNTIME_HEALTH_POLL_MS = 2_000;
const SOCKET_PROBE_TIMEOUT_MS = 3_000;
const PLACEHOLDER_URL = "http://127.0.0.1";

export type {
  ProviderKind,
  RuntimeAction,
  RuntimePhase,
  RuntimePullProgress,
  RuntimeStatus,
} from "./provider";

export class RuntimeManager extends EventEmitter {
  private readonly paths: RuntimePaths;
  private readonly image: string;
  private readonly provider: LimaRuntimeProvider;
  private activeOperation: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private status: RuntimeStatus;
  private localProxy: LocalProxy | null = null;

  constructor() {
    super();
    this.paths = resolveRuntimePaths();
    this.image = DEFAULT_RUNTIME_IMAGE;
    this.provider = selectProvider(this.paths);
    this.status = this.createStatus(
      "checking_host",
      "Checking your computer",
      "Looking for the local Rome runtime.",
      "none",
    );
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status.phase === "ready";
  }

  getDashboardUrl(): string {
    return this.localProxy?.url ?? PLACEHOLDER_URL;
  }

  getImage(): string {
    return this.image;
  }

  async getLocalImageDigest(): Promise<string | null> {
    return this.provider.getLocalImageDigest(this.image);
  }

  async ensureReady(): Promise<void> {
    return this.runExclusive(() => this.runEnsureReady());
  }

  async upgradeRuntime(): Promise<void> {
    return this.runExclusive(() => this.runUpgradeRuntime());
  }

  /**
   * Called from the quit path. Emits a "stopping" phase so any open UI can
   * reflect that the runtime is going down, then asks the provider to stop
   * the Rome container (graceful SIGTERM) and the VM (graceful shutdown,
   * --force fallback). Never throws — quit must always be able to proceed.
   *
   * Bypasses runExclusive on purpose: quit should not wait for an in-flight
   * pull or boot. Provider stop methods are best-effort and tolerate
   * being run against a runtime that is mid-startup. Idempotent via its
   * own promise cache.
   */
  async stopForQuit(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.runStopForQuit();
    }
    return this.stopPromise;
  }

  async openInstallPage(): Promise<void> {
    await this.provider.openInstallPage();
  }

  async startRuntimeApp(): Promise<void> {
    await this.provider.startRuntime();
  }

  async openRuntimeFolder(): Promise<void> {
    mkdirSync(this.paths.rootDir, { recursive: true });
    const error = await shell.openPath(this.paths.rootDir);
    if (error) throw new Error(error);
  }

  async openLogs(): Promise<void> {
    const error = await shell.openPath(this.paths.debugLogFile);
    if (error) throw new Error(error);
  }

  private async runEnsureReady(): Promise<void> {
    try {
      // Before anything else, for two reasons. Every RuntimeStatus this method
      // emits carries `dashboardUrl`, and the onboarding page navigates to it —
      // so it has to be the real origin from the first phase, not the port-80
      // placeholder. And binding fails fast on a squatted port, which is worth
      // learning now rather than after an eight-minute startup.
      //
      // The proxy is only a loopback listener; it does not need the Unix socket
      // to exist yet.
      await this.ensureLocalProxy();

      this.setPhase(
        "checking_host",
        "Checking your computer",
        "Looking for the local Rome runtime.",
        "none",
      );

      const probe = await this.provider.probeHost();
      if (!probe.runtimeInstalled) {
        this.setPhase(
          "installing_runtime",
          "Install the local runtime",
          probe.detail,
          "install_runtime",
          probe,
        );
        return;
      }

      if (!probe.runtimeRunning) {
        this.setPhase(
          "starting_runtime",
          "Starting the local runtime",
          probe.detail,
          "none",
          probe,
        );
        const started = await this.provider.startRuntime();
        if (!started) {
          this.setPhase(
            "starting_runtime",
            "Runtime did not start",
            "The local runtime did not finish starting in time. Try again, or check Send diagnostics.",
            "retry",
            { ...probe, runtimeRunning: false },
          );
          return;
        }
      }

      const readyProbe: Partial<RuntimeHostProbe> = {
        runtimeInstalled: true,
        runtimeRunning: true,
      };

      await this.ensureRuntimeFiles();

      if (!(await this.provider.imageExists(this.image))) {
        this.setPhase(
          "pulling_image",
          "Downloading Rome",
          "Downloading the Rome runtime the first time can take a few minutes.",
          "none",
          readyProbe,
        );
        await this.provider.pullImage(this.image, (progress) => this.updatePullProgress(progress));
      }

      await this.runStartAndHealth(
        "Starting the local Rome runtime.",
        "Your local Rome runtime is running and the dashboard is ready to open.",
        readyProbe,
        false,
      );
    } catch (error) {
      log.error("Local runtime setup failed", error);
      this.setPhase(
        "failed",
        "Setup needs attention",
        error instanceof Error ? error.message : String(error),
        "retry",
      );
    }
  }

  private async runUpgradeRuntime(): Promise<void> {
    try {
      // Same reasons as runEnsureReady: a real dashboardUrl on every emitted
      // status, and a squatted port surfaces before the long work starts.
      await this.ensureLocalProxy();

      this.setPhase(
        "checking_host",
        "Checking the local runtime",
        "Preparing the local Rome runtime for an update.",
        "none",
      );

      const probe = await this.provider.probeHost();
      if (!probe.runtimeInstalled) {
        this.setPhase(
          "installing_runtime",
          "Install the local runtime",
          probe.detail,
          "install_runtime",
          probe,
        );
        return;
      }

      if (!probe.runtimeRunning) {
        this.setPhase(
          "starting_runtime",
          "Starting the local runtime",
          probe.detail,
          "none",
          probe,
        );
        const started = await this.provider.startRuntime();
        if (!started) {
          this.setPhase(
            "starting_runtime",
            "Runtime did not start",
            "The local runtime did not finish starting in time. Try again.",
            "retry",
            { ...probe, runtimeRunning: false },
          );
          return;
        }
      }

      await this.ensureRuntimeFiles();

      const readyProbe: Partial<RuntimeHostProbe> = {
        runtimeInstalled: true,
        runtimeRunning: true,
      };

      this.setPhase(
        "pulling_image",
        "Updating Rome",
        "Pulling the latest Rome runtime image.",
        "none",
        readyProbe,
      );
      await this.provider.pullImage(this.image, (progress) => this.updatePullProgress(progress));

      await this.runStartAndHealth(
        "Restarting the local Rome runtime with the latest image.",
        "Rome is running with the latest local image.",
        readyProbe,
        true,
      );

      // Drop the previous image's dangling layers now that the new container
      // is up and healthy. nerdctl image prune --force only removes images
      // with no referring containers, so the running Rome stays intact.
      // Provider's prune is best-effort and never throws — quiet log only.
      void this.provider.pruneDanglingImages();
    } catch (error) {
      log.error("Runtime upgrade failed", error);
      this.setPhase(
        "failed",
        "Upgrade needs attention",
        error instanceof Error ? error.message : String(error),
        "retry",
      );
    }
  }

  private async runStartAndHealth(
    startingDetail: string,
    readyDetail: string,
    probe: Partial<RuntimeHostProbe>,
    forceRecreate: boolean,
  ): Promise<void> {
    this.setPhase("starting_rome", "Starting Rome", startingDetail, "none", probe);

    // The provider decides whether to no-op, restart in place, or fully
    // recreate based on container state + envHash + image. It also owns
    // wiping the host socket file when it knows the container is going away,
    // so we leave a live socket alone in the reuse path.
    mkdirSync(this.paths.homeDir, { recursive: true });

    await this.provider.startContainer({
      image: this.image,
      envFile: this.paths.envFile,
      rootDir: this.paths.rootDir,
      socketPath: this.paths.socketPath,
      homeDir: this.paths.homeDir,
      forceRecreate,
    });

    this.setPhase(
      "waiting_for_health",
      "Finishing setup",
      "Waiting for the Rome dashboard to become available.",
      "none",
      probe,
    );

    let healthy = await this.waitForSocketHealth(RUNTIME_HEALTH_TIMEOUT_MS);

    if (!healthy && !forceRecreate) {
      // The provider reused a container that turned out not to serve. That is
      // reachable: an unclean VM shutdown can leave containerd reporting a
      // container as running with no live task behind it, and the reuse check
      // believes it. Retrying without this would take the same decision and
      // hang the same way, so the only escape would be the update button.
      //
      // Recreating is cheap relative to being stuck, and it is what every
      // launch did before the reuse check was repaired.
      log.warn("Runtime did not become healthy; recreating the container once and retrying");
      // A distinct detail, because this re-emits phases the UI has already
      // passed: the onboarding steps un-check and rewind. Reusing
      // `startingDetail` would show that reversal with no reason for it, after
      // the user has already waited out a full health timeout.
      this.setPhase(
        "starting_rome",
        "Starting Rome",
        "Rome did not come up. Rebuilding the runtime and trying once more.",
        "none",
        probe,
      );
      await this.provider.startContainer({
        image: this.image,
        envFile: this.paths.envFile,
        rootDir: this.paths.rootDir,
        socketPath: this.paths.socketPath,
        homeDir: this.paths.homeDir,
        forceRecreate: true,
      });
      this.setPhase(
        "waiting_for_health",
        "Finishing setup",
        // Distinct from the first pass. This is the phase the user spends the
        // retry in, and the elapsed counter restarts here — an identical string
        // would make the screen pixel-identical to the wait that just failed.
        "Waiting for the rebuilt runtime to come up.",
        "none",
        probe,
      );
      healthy = await this.waitForSocketHealth(RUNTIME_HEALTH_RETRY_TIMEOUT_MS);
    }

    if (!healthy) {
      throw new Error("Rome started, but the dashboard did not become healthy in time.");
    }

    await this.ensureLocalProxy();
    this.setPhase("ready", "Rome is ready", readyDetail, "open_dashboard", probe);

    // Only now: until this image has served, the previous one is the fallback.
    // And only for a pinned release — see isPinnedRelease for why a dev build
    // and an override are both left alone.
    if (RUNTIME_IMAGE_IS_PINNED) {
      void this.provider.removeOtherImageTags(this.image);
    }
  }

  private async runStopForQuit(): Promise<void> {
    this.setPhase(
      "stopping",
      "Stopping Rome",
      "Shutting down the local Rome agent and runtime.",
      "none",
    );
    try {
      await this.provider.stopContainer();
    } catch (error) {
      log.error("stopContainer failed during quit", error);
    }
    try {
      await this.provider.stopRuntime();
    } catch (error) {
      log.error("stopRuntime failed during quit", error);
    }
    await this.closeLocalProxy();
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    if (this.activeOperation) return this.activeOperation;
    this.activeOperation = operation().finally(() => {
      this.activeOperation = null;
    });
    return this.activeOperation;
  }

  private createStatus(
    phase: RuntimePhase,
    title: string,
    detail: string,
    primaryAction: RuntimeAction,
    probe?: Partial<RuntimeHostProbe>,
  ): RuntimeStatus {
    const dashboardUrl = this.localProxy?.url ?? PLACEHOLDER_URL;
    return {
      phase,
      title,
      detail,
      primaryAction,
      dashboardUrl,
      healthUrl: `${dashboardUrl}/api/health`,
      installDir: this.paths.rootDir,
      image: this.image,
      containerName: this.provider.containerName,
      provider: this.provider.kind,
      runtimeInstalled: probe?.runtimeInstalled ?? this.status?.runtimeInstalled ?? false,
      runtimeRunning: probe?.runtimeRunning ?? this.status?.runtimeRunning ?? false,
      runtimeInstallUrl: probe?.installUrl ?? this.status?.runtimeInstallUrl ?? "",
      lastError: phase === "failed" ? detail : null,
      pullProgress: null,
    };
  }

  private setPhase(
    phase: RuntimePhase,
    title: string,
    detail: string,
    primaryAction: RuntimeAction,
    probe?: Partial<RuntimeHostProbe>,
  ): void {
    this.status = this.createStatus(phase, title, detail, primaryAction, probe);
    this.emit("status", this.status);
    log.info(`${title}: ${detail}`);
  }

  private updatePullProgress(progress: RuntimePullProgress): void {
    if (this.status.phase !== "pulling_image") return;
    this.status = { ...this.status, pullProgress: progress };
    this.emit("status", this.status);
  }

  private async ensureRuntimeFiles(): Promise<void> {
    mkdirSync(this.paths.rootDir, { recursive: true });

    const existingEnv = existsSync(this.paths.envFile)
      ? parseSimpleEnvFile(readFileSync(this.paths.envFile, "utf8"))
      : new Map<string, string>();
    // No instance token is injected here: the in-VM Rome enrolls
    // through its own dashboard connect flow and owns the durable token in its
    // DB. The desktop only boots the runtime; it never holds the token.
    const envContents = generateRuntimeEnv({
      jwtSecret: existingEnv.get("ROME_JWT_SECRET"),
      anthropicApiKey: existingEnv.get("ANTHROPIC_API_KEY") ?? null,
      // Container-side public origin still uses TCP since that's what Rome's
      // own HTTP server sees.
      publicOrigin: "http://127.0.0.1:8080",
      // ...but every loopback OAuth redirect_uri must be the host-reachable
      // proxy, because that is the origin the browser is actually on. Rome does
      // need to know about the proxy after all: it cannot observe the port, so
      // the host states it here.
      //
      // Built from the port rather than read off a running proxy. What this
      // needs is the port, not a listening socket, and getDashboardUrl() is the
      // port-80 placeholder until the proxy exists — so sourcing it there would
      // make a reordering silently write an origin core rejects, landing back
      // on the dead end this whole change removes.
      instanceOrigin: `http://127.0.0.1:${resolveProxyPort()}`,
    });

    writeManagedRuntimeEnv(this.paths.envFile, envContents);
  }

  private async probeSocketHealth(): Promise<boolean> {
    if (!existsSync(this.paths.socketPath)) return false;
    return new Promise((resolve) => {
      const req = request(
        {
          socketPath: this.paths.socketPath,
          method: "GET",
          path: "/api/health",
          timeout: SOCKET_PROBE_TIMEOUT_MS,
        },
        (res) => {
          resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
          res.resume();
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private async waitForSocketHealth(budgetMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < budgetMs) {
      if (await this.probeSocketHealth()) return true;
      await new Promise((resolve) => setTimeout(resolve, RUNTIME_HEALTH_POLL_MS));
    }
    // One last look before giving up. The loop leaves up to a poll interval
    // between its final probe and the deadline, and losing that race costs a
    // full teardown and rebuild of a runtime that had just come up.
    return this.probeSocketHealth();
  }

  private async ensureLocalProxy(): Promise<void> {
    if (this.localProxy) return;
    this.localProxy = await startLocalProxy(this.paths.socketPath, resolveProxyPort());
  }

  /**
   * Cheap liveness check for callers that only need "can I navigate there right
   * now" — notably deep links. Unlike isReady() this checks for real instead of
   * trusting the last recorded phase, and unlike ensureReady() it never starts,
   * stops, or recreates anything.
   *
   * Both halves matter. A caller navigates to getDashboardUrl(), which is the
   * port-80 placeholder until the proxy exists, and the socket can answer from a
   * container that survived the last session before the proxy has started.
   */
  async isServing(): Promise<boolean> {
    if (!this.localProxy) return false;
    return this.probeSocketHealth();
  }

  private async closeLocalProxy(): Promise<void> {
    if (!this.localProxy) return;
    try {
      await this.localProxy.close();
    } catch (error) {
      log.error("Local proxy close failed", error);
    }
    this.localProxy = null;
  }
}

export interface SelectProviderHost {
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
}

export function selectProvider(
  paths: RuntimePaths,
  host: SelectProviderHost = {},
): LimaRuntimeProvider {
  const platform = host.platform ?? process.platform;
  const arch = host.arch ?? process.arch;
  const release_ = host.release ?? release();
  if (platform !== "darwin" || arch !== "arm64" || !isMacOs13OrNewer(release_)) {
    throw new Error(
      "Rome requires macOS 13 (Ventura) or newer on Apple Silicon. " +
        "The bundled Linux runtime is not available on this host.",
    );
  }
  return new LimaRuntimeProvider({ hostSocketPath: paths.socketPath });
}

// Darwin kernel 22.x corresponds to macOS 13 (Ventura), the floor for Lima's
// `vmType: vz` Virtualization.framework requirement.
function isMacOs13OrNewer(release_ = release()): boolean {
  const major = Number.parseInt(release_.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) && major >= 22;
}
