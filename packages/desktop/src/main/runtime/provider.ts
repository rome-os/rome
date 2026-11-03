export type RuntimePhase =
  | "starting_rome"
  | "waiting_for_health"
  | "ready"
  // A hosted Rome that cannot open until the user acts: sign in, pick one,
  // or start or create it in Rome Cloud. `primaryAction` says which.
  | "waiting_for_user"
  | "failed";

export type RuntimeAction =
  | "retry"
  | "open_dashboard"
  | "sign_in"
  | "choose_instance"
  | "open_cloud"
  | "none";

export interface RuntimeStatus {
  phase: RuntimePhase;
  title: string;
  detail: string;
  primaryAction: RuntimeAction;
  dashboardUrl: string;
  lastError: string | null;
}
