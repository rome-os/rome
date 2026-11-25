import type { Context } from "hono";
import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { mayEnter } from "../../access/entry.js";
import { currentSessionActor } from "../../access/session-actor.js";
import type { TeamActor } from "../../access/team.js";
import { teamOnly } from "../../access/team-only.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:approvals");

type ApprovalStatus = "pending" | "approved" | "rejected" | "auto_approved";
const VALID_STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected", "auto_approved"];

/** The one action whose approval needs the guardian's PIN, entered through `POST /vault/grants`. */
export const VAULT_APPLY_ACTION = "system:vault_apply";

/** The action an approval's payload asks to run, or an empty object when the payload names none. */
export function approvalCall(approval: { payload: unknown } | null | undefined): {
  actionName?: unknown;
  args?: Record<string, unknown>;
} {
  return (approval?.payload ?? {}) as { actionName?: unknown; args?: Record<string, unknown> };
}

/** Who resolved an approval, as `resolvedBy` records it: the guardian's seat id, or "visitor:<account>". */
export function resolverOf(actor: TeamActor): string {
  return actor.kind === "guardian" ? actor.userId : `visitor:${actor.accountId}`;
}

type ApprovalResolution = {
  status: 202 | 404 | 409;
  body: Record<string, unknown>;
};

/**
 * Resolves a pending approval and starts what follows: the action's execution
 * on approve, its rejection handling on reject. It checks no actor and no
 * PIN, so the caller decides who may call it.
 */
export async function resolveApproval(
  deps: Pick<ApiDeps, "approvalHandler" | "approvalsRepo">,
  approvalId: string,
  action: "approve" | "reject",
  userId: string,
): Promise<ApprovalResolution> {
  const { approvalHandler, approvalsRepo } = deps;
  const resolveResult = await approvalsRepo.resolvePending(approvalId, action, userId);
  if (resolveResult.outcome === "not_found") {
    return { status: 404, body: { error: "Approval not found" } };
  }
  if (resolveResult.outcome === "already_resolved") {
    return {
      status: 409,
      body: { error: "Approval already resolved", approval: resolveResult.approval },
    };
  }

  const approval = resolveResult.approval;
  if (action === "approve" && approval.type === "action_execution") {
    approvalHandler.onApproved(approvalId).catch((err) => {
      log.error("approval execution failed", {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (action === "reject" && approval.type === "action_execution") {
    approvalHandler.onRejected(approvalId).catch((err) => {
      log.error("approval rejection handling failed", {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    status: 202,
    body: { ok: true, status: "accepted", approvalId, action, approval },
  };
}

async function resolveApprovalRoute(c: Context, deps: ApiDeps, action: "approve" | "reject") {
  const approvalId = c.req.param("id") as string;
  const actor = await mayEnter(await currentSessionActor(), deps.dashboardAccessState);
  if (!actor) return c.json({ error: "Guardian authentication required" }, 403);
  if (action === "approve") {
    const approval = await deps.approvalsRepo.findById(approvalId);
    if (approvalCall(approval).actionName === VAULT_APPLY_ACTION) {
      return c.json(
        { error: "Approve this with your PIN in the dashboard.", code: "pin_required" },
        422,
      );
    }
  }
  const { status, body } = await resolveApproval(deps, approvalId, action, resolverOf(actor));
  return c.json(body, status);
}

export function approvalsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const team = teamOnly(deps.dashboardAccessState);
  app.use("/approvals", team);
  app.use("/approvals/*", team);
  app.use("/approvals/*", async (c, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !isSameOriginMutationRequest(c.req.raw)
    )
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    await next();
  });
  app.get("/approvals", async (c) => {
    const status = c.req.query("status");
    const rows = await deps.approvalsRepo.list(
      status && VALID_STATUSES.includes(status as ApprovalStatus)
        ? (status as ApprovalStatus)
        : undefined,
    );
    return c.json(rows);
  });

  app.get("/approvals/:id", async (c) => {
    const approval = await deps.approvalsRepo.findById(c.req.param("id"));
    if (!approval) {
      return c.json({ error: "Approval not found" }, 404);
    }
    return c.json(approval);
  });

  app.post("/approvals/:id/resolve", async (c) => {
    const body = await c.req.json<{ action?: string }>().catch(() => ({}) as { action?: string });
    const action = body.action;
    if (action !== "approve" && action !== "reject") {
      return c.json({ error: `Invalid action: "${action}". Must be "approve" or "reject".` }, 400);
    }
    return resolveApprovalRoute(c, deps, action);
  });

  app.post("/approvals/:id/approve", async (c) => {
    return resolveApprovalRoute(c, deps, "approve");
  });

  app.post("/approvals/:id/reject", async (c) => {
    return resolveApprovalRoute(c, deps, "reject");
  });

  app.post("/approvals/:id/retry", async (c) => {
    const { approvalHandler, approvalsRepo } = deps;
    const approvalId = c.req.param("id");
    const retryResult = await approvalsRepo.retryFailedExecution(approvalId);
    if (retryResult.outcome === "not_found") {
      return c.json({ error: "Approval not found" }, 404);
    }
    if (retryResult.outcome === "not_retryable") {
      return c.json({ error: "Approval is not retryable", approval: retryResult.approval }, 409);
    }

    approvalHandler.onApproved(approvalId).catch((err) => {
      log.error("approval retry execution failed", {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json(
      { ok: true, status: "accepted", approvalId, action: "retry", approval: retryResult.approval },
      202,
    );
  });

  return app;
}
