import type { ResolvedApp } from "../apps/state.js";
import type { RomeAppViewer } from "../access/visitor-session.js";
import type { FavorRequiredActionDefinition } from "@rome-os/app-runtime";

// The HTTP-facing shapes live in @rome/api-types so the dashboard and its mock
// handlers bind to the same contract. Re-exported here because the rest of the
// favors subsystem imports them from this module.
export type {
  FavorActionAuthorization,
  FavorActionRequestDispatchStatus,
  FavorActionRequestStatus,
  FavorActionRequestSyncPage,
  FavorActionRequestView,
  FavorBalanceView,
  FavorLedgerEntryView,
  FavorLedgerKind,
  FavorLedgerPage,
  FavorRechargeCheckout,
  FavorRechargePackList,
  FavorRechargePackView,
} from "@rome/api-types/favors";

import type {
  FavorActionAuthorization,
  FavorActionRequestSyncPage,
  FavorActionRequestView,
  FavorBalanceView,
  FavorLedgerPage,
  FavorRechargeCheckout,
  FavorRechargePackList,
} from "@rome/api-types/favors";

export type FavorActionDispatchClaim =
  | {
      status: "claimed";
      actionRequestId: string;
      claimToken: string;
      claimExpiresAt: string;
      dispatchAttempt: number;
      actionRef: Record<string, unknown>;
      actionRefHash: string;
      definitionHash: string;
      displayPayload: Record<string, unknown>;
    }
  | {
      status: "not_claimable";
      reason: "not_settled" | "blocked" | "already_claimed" | "already_completed";
      claimExpiresAt?: string;
    };

export type FavorActionDispatchResult =
  | {
      claimToken: string;
      actionRefHash: string;
      status: "succeeded";
      completedAt?: string;
      outputRef?: Record<string, unknown>;
    }
  | {
      claimToken: string;
      actionRefHash: string;
      status: "action_failed";
      completedAt?: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    };

export interface FavorService {
  getBalance(viewer?: RomeAppViewer): Promise<FavorBalanceView>;
  listLedger(cursor?: string, viewer?: RomeAppViewer): Promise<FavorLedgerPage>;
  getActionRequest(id: string, viewer?: RomeAppViewer): Promise<FavorActionRequestView>;
  syncActionRequests(cursor?: string): Promise<FavorActionRequestSyncPage>;
  listActionRequests(cursor?: string, viewer?: RomeAppViewer): Promise<FavorActionRequestSyncPage>;
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
  resolveActionRequest(
    id: string,
    decision: "pay" | "decline",
    viewer?: RomeAppViewer,
  ): Promise<FavorActionAuthorization>;
  claimDispatch(id: string): Promise<FavorActionDispatchClaim>;
  renewDispatchClaim(id: string, claimToken: string): Promise<{ claimExpiresAt: string }>;
  reportDispatchResult(id: string, result: FavorActionDispatchResult): Promise<void>;
  listRechargePacks(viewer?: RomeAppViewer): Promise<FavorRechargePackList>;
  createRechargeCheckout(packId: string, viewer?: RomeAppViewer): Promise<FavorRechargeCheckout>;
  syncActionRequirements(input: {
    appId: string;
    requesterAppIdentity: Record<string, unknown>;
    definitions: FavorRequiredActionDefinition[];
  }): Promise<{ synced: number }>;
}
