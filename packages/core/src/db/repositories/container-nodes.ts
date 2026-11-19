import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { CONTAINER_NODE_GRANT_LIFETIME_MS } from "@rome/api-types/devices";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { containerNodeInstallations as nodes } from "../schema.js";

const redemptionRecoveryWindow = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function installationToken(key: Buffer, guardianId: string, id: string, nonce: string) {
  return `romeinstall_${createHmac("sha256", key)
    .update(JSON.stringify(["rome-container-installation", guardianId, id, nonce]))
    .digest("base64url")}`;
}

export class ContainerNodesRepository {
  constructor(private db: DrizzleDb) {}

  list(guardianId: string) {
    return this.db.select().from(nodes).where(eq(nodes.guardianId, guardianId)).all();
  }

  devices() {
    return this.db
      .select({ installationId: nodes.id, deviceId: nodes.deviceId, name: nodes.name })
      .from(nodes)
      .all();
  }

  findByDeviceId(deviceId: string) {
    return this.db.select().from(nodes).where(eq(nodes.deviceId, deviceId)).get();
  }

  findByToken(token: string) {
    return this.db
      .select()
      .from(nodes)
      .where(eq(nodes.tokenHash, hash(token)))
      .get();
  }

  issue(
    guardianId: string,
    input: { name: string } | { id: string },
    now = Date.now(),
    compose?: { origin: string; key: Buffer },
  ) {
    const id = "id" in input ? input.id : randomUUID();
    const deployment = compose
      ? { origin: compose.origin, nonce: randomBytes(32).toString("base64url") }
      : null;
    const installToken =
      compose && deployment
        ? installationToken(compose.key, guardianId, id, deployment.nonce)
        : `romeinstall_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + CONTAINER_NODE_GRANT_LIFETIME_MS;
    const grant = { grantHash: hash(installToken), expiresAt, deployment };
    return this.db.transaction(
      (tx) => {
        if ("id" in input) {
          const target = and(eq(nodes.id, id), eq(nodes.guardianId, guardianId));
          const existing = tx.select({ deviceId: nodes.deviceId }).from(nodes).where(target).get();
          if (!existing) return { outcome: "node_not_found" } as const;
          if (existing.deviceId) return { outcome: "already_paired" } as const;
          tx.update(nodes)
            .set({ ...grant, verifierHash: null, redeemedAt: null })
            .where(target)
            .run();
        } else {
          tx.insert(nodes)
            .values({ id, guardianId, name: input.name, ...grant })
            .run();
        }
        return {
          outcome: "issued",
          id,
          installToken,
          expiresAt: new Date(expiresAt).toISOString(),
        } as const;
      },
      { behavior: "immediate" },
    );
  }

  compose(guardianId: string, id: string, key: Buffer, now = Date.now()) {
    const row = this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.guardianId, guardianId), eq(nodes.id, id)))
      .get();
    if (!row || row.expiresAt === null || row.expiresAt <= now)
      return { outcome: "node_not_found" } as const;
    if (row.deviceId) return { outcome: "already_paired" } as const;
    if (!row.deployment) return { outcome: "compose_unavailable" } as const;
    const installToken = installationToken(key, guardianId, id, row.deployment.nonce);
    if (hash(installToken) !== row.grantHash) return { outcome: "compose_unavailable" } as const;
    return {
      outcome: "available",
      grant: {
        id,
        installToken,
        expiresAt: new Date(row.expiresAt).toISOString(),
        origin: row.deployment.origin,
      },
    } as const;
  }

  renameInstallation(guardianId: string, id: string, name: string, now = Date.now()) {
    return (
      this.db
        .update(nodes)
        .set({ name })
        .where(
          and(
            eq(nodes.guardianId, guardianId),
            eq(nodes.id, id),
            isNull(nodes.deviceId),
            gt(nodes.expiresAt, now),
          ),
        )
        .run().changes > 0
    );
  }

  redeem(id: string, installToken: string, verifier: string, now = Date.now()) {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(nodes).where(eq(nodes.id, id)).get();
        if (!row || row.grantHash !== hash(installToken) || row.expiresAt === null)
          return { outcome: "invalid" } as const;
        const verifierHash = hash(verifier);
        if (row.redeemedAt !== null && row.verifierHash !== verifierHash)
          return { outcome: "claimed" } as const;
        const deadline =
          row.redeemedAt === null ? row.expiresAt : row.redeemedAt + redemptionRecoveryWindow;
        if (now >= deadline) return { outcome: "expired" } as const;
        const deviceId = row.deviceId ?? randomUUID();
        // Only the original token and verifier can reconstruct a lost reply. The database holds hashes.
        const token = `romedev_${createHmac("sha256", installToken)
          .update(`rome-container-node:${id}:${deviceId}:${verifier}`)
          .digest("base64url")}`;
        if (row.redeemedAt === null) {
          tx.update(nodes)
            .set({
              verifierHash,
              redeemedAt: now,
              deviceId,
              tokenHash: hash(token),
              deployment: null,
            })
            .where(eq(nodes.id, id))
            .run();
        } else if (!row.deviceId || row.tokenHash !== hash(token)) {
          return { outcome: "invalid" } as const;
        }
        return { outcome: "redeemed", deviceId, token, guardianId: row.guardianId } as const;
      },
      { behavior: "immediate" },
    );
  }

  rename(deviceId: string, name: string) {
    return (
      this.db.update(nodes).set({ name }).where(eq(nodes.deviceId, deviceId)).run().changes > 0
    );
  }

  removeInstallation(guardianId: string, id: string) {
    const target = and(eq(nodes.id, id), eq(nodes.guardianId, guardianId));
    return this.db.transaction(
      (tx) => {
        const row = tx.select({ deviceId: nodes.deviceId }).from(nodes).where(target).get();
        if (!row) return "node_not_found";
        if (row.deviceId) return "already_paired";
        tx.delete(nodes).where(target).run();
        return "removed";
      },
      { behavior: "immediate" },
    );
  }

  revoke(deviceId: string) {
    return (
      this.db
        .update(nodes)
        .set({
          deviceId: null,
          tokenHash: null,
          grantHash: null,
          deployment: null,
          expiresAt: null,
          verifierHash: null,
          redeemedAt: null,
        })
        .where(eq(nodes.deviceId, deviceId))
        .run().changes > 0
    );
  }
}
