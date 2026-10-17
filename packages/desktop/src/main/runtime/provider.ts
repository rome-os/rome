// `remote` is a hosted Rome the app only opens; it has no VM to provision.
export type ProviderKind = "lima" | "remote";

export type RuntimePhase =
  | "checking_host"
  | "installing_runtime"
  | "starting_runtime"
  | "pulling_image"
  | "starting_rome"
  | "waiting_for_health"
  | "ready"
  | "stopping"
  // A hosted Rome that cannot open until the user acts: sign in, pick one,
  // or start or create it in Rome Cloud. `primaryAction` says which.
  | "waiting_for_user"
  | "failed";

export type RuntimeAction =
  | "install_runtime"
  | "open_runtime_app"
  | "retry"
  | "open_dashboard"
  | "sign_in"
  | "choose_instance"
  | "open_cloud"
  | "none";

export interface RuntimePullProgress {
  percent: number | null;
  status: string;
  currentBytes: number;
  totalBytes: number;
  layersCompleted: number;
  layersTotal: number;
  /**
   * Coarse lifecycle of the in-flight pull. `downloading` covers blob fetches,
   * `unpacking` covers post-download extract/commit (the long tail after the
   * UI hits 100%), and `done` is set by the pull driver right before returning.
   */
  phase: "downloading" | "unpacking" | "done";
}

export interface RuntimeHostProbe {
  runtimeInstalled: boolean;
  runtimeRunning: boolean;
  detail: string;
  installUrl: string;
}

export interface StartContainerArgs {
  image: string;
  envFile: string;
  rootDir: string;
  /**
   * Absolute host filesystem path where the runtime should publish the
   * container's HTTP listener as a Unix domain socket. It must stay off
   * vmnet so host-side TUN proxies cannot intercept it.
   */
  socketPath: string;
  /**
   * Absolute host filesystem path bind-mounted into the container as
   * /home/rome so the entire Rome user home — per-profile state under
   * .rome/ plus any CLI login state (claude-code's .claude/, codex's
   * .codex/, gh's .config/gh/, .gitconfig, …) — survives container
   * removal and image upgrades.
   */
  homeDir: string;
  /**
   * If true, tear down any existing container and start a fresh one. If
   * false (default), reuse a still-running container whose image/env match
   * the requested config, or restart a stopped container in place rather
   * than recreating from scratch.
   * Upgrades set this true since the image just changed underneath.
   */
  forceRecreate?: boolean;
}

export interface RuntimeStatus {
  phase: RuntimePhase;
  title: string;
  detail: string;
  primaryAction: RuntimeAction;
  dashboardUrl: string;
  healthUrl: string;
  installDir: string;
  image: string;
  containerName: string;

  provider: ProviderKind;
  runtimeInstalled: boolean;
  runtimeRunning: boolean;
  runtimeInstallUrl: string;

  lastError: string | null;
  pullProgress: RuntimePullProgress | null;
}
