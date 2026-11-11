import type { FavorActionRequestView } from "@rome/api-types/favors";
import type { RomeAppViewer } from "../access/visitor-session.js";
import type { ResolvedApp } from "./state.js";

/**
 * What Apps needs to give an app `ctx.favors`: a request that a visitor pay
 * for one of the app's actions. Favors supplies it.
 */
export interface AppFavorRequests {
  requestAction(input: {
    app: ResolvedApp;
    viewer: RomeAppViewer;
    actionName: string;
    args: Record<string, unknown>;
    taskRef?: Record<string, unknown>;
    idempotencyKey: string;
    /**
     * App-suggested page (absolute path on the instance origin, e.g.
     * `/apps/<appId>/checkout?x=1`) the payer returns to after deciding on
     * Rome Cloud. Validated by the service: it must stay within the
     * requesting app's `/apps/<appId>` prefix, otherwise the app root is
     * used instead.
     */
    returnTo?: string;
  }): Promise<
    | { status: "queued"; request: FavorActionRequestView }
    | { status: "pending_consent"; request: FavorActionRequestView; authorizationUrl: string }
    | { status: "declined"; request: FavorActionRequestView }
    | { status: "error"; error: string }
  >;
}
