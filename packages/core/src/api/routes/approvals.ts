import { pairingPayload } from "@rome/api-types/approvals";
import type { Context } from "hono";
import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { currentSessionActor } from "../../lib/session-actor.js";
import { notifyPairingResolution } from "../../channels/pairing.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:approvals");

type ApprovalStatus = "pending" | "approved" | "rejected" | "auto_approved";
const VALID_STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected", "auto_approved"];

async function resolveApproval(c: Context, deps: ApiDeps, action: "approve" | "reject") {
  const { approvalHandler, approvalsRepo, personMappingRepo } = deps;
  const approvalId = c.req.param("id") as string;
  const actor = await currentSessionActor();
  if (actor?.kind !== "guardian") return c.json({ error: "Guardian authentication required" }, 403);
  const resolveResult = await approvalsRepo.resolvePending(approvalId, action, actor.userId);
  if (resolveResult.outcome === "not_found") {
    return c.json({ error: "Approval not found" }, 404);
  }
  if (resolveResult.outcome === "already_resolved") {
    return c.json({ error: "Approval already resolved", approval: resolveResult.approval }, 409);
  }

  const approval = resolveResult.approval;
  if (pairingPayload(approval)?.resolution === "account_linked") {
    return c.json(
      { error: "This account is already linked. Pairing was not approved.", approval },
      409,
    );
  }
  await notifyPairingResolution(deps.talkRouter, approval);
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

  if (action === "reject" && approval.type === "person_mapping") {
    const payload = approval.payload as Record<string, unknown> | null;
    if (payload?.action === "auto_mapped_existing") {
      const channel = payload.channel;
      const channelUserId = payload.channelUserId;
      if (typeof channel === "string" && typeof channelUserId === "string") {
        try {
          await personMappingRepo.deleteChannelMapping(channel, channelUserId);
        } catch (err) {
          log.error("failed to cleanup auto-mapped channel mapping on rejection", {
            approvalId,
            channel,
            channelUserId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return c.json({ ok: true, status: "accepted", approvalId, action, approval }, 202);
}

export function approvalsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  app.use("/approvals/*", async (c, next) => {
    if ((await currentSessionActor())?.kind !== "guardian")
      return c.json({ error: "Guardian authentication required" }, 403);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !isSameOriginMutationRequest(c.req.raw)
    )
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    await next();
  });
  app.use("/approvals", async (c, next) => {
    if ((await currentSessionActor())?.kind !== "guardian")
      return c.json({ error: "Guardian authentication required" }, 403);
    await next();
  });
  app.get("/approvals/:id/code", async (c) => {
    c.header("Cache-Control", "no-store");
    const code = await deps.approvalsRepo.pairingCode(c.req.param("id"));
    return c.json({ code });
  });

  app.get("/approvals", async (c) => {
    const status = c.req.query("status");
    const offset = Number(c.req.query("pairingHistoryOffset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0)
      return c.json({ error: "Invalid history offset" }, 400);
    const rows = await deps.approvalsRepo.list(
      status && VALID_STATUSES.includes(status as ApprovalStatus)
        ? (status as ApprovalStatus)
        : undefined,
      offset,
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
    return resolveApproval(c, deps, action);
  });

  app.post("/approvals/:id/approve", async (c) => {
    return resolveApproval(c, deps, "approve");
  });

  app.post("/approvals/:id/reject", async (c) => {
    return resolveApproval(c, deps, "reject");
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
