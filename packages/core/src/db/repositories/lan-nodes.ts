import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { lanNodeInstallations as nodes } from "../schema.js";

const grantLifetime = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class LanNodesRepository {
  constructor(private db: DrizzleDb) {}

  list(guardianId: string) {
    return this.db.select().from(nodes).where(eq(nodes.guardianId, guardianId)).all();
  }

  devices() {
    return this.db.select({ deviceId: nodes.deviceId, name: nodes.name }).from(nodes).all();
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

  issue(guardianId: string, input: { name: string } | { id: string }, now = Date.now()) {
    const installToken = `romeinstall_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + grantLifetime;
    const grant = { grantHash: hash(installToken), expiresAt };
    return this.db.transaction(
      (tx) => {
        let id: string;
        if ("id" in input) {
          id = input.id;
          const target = and(eq(nodes.id, id), eq(nodes.guardianId, guardianId));
          const existing = tx.select({ deviceId: nodes.deviceId }).from(nodes).where(target).get();
          if (!existing) return { outcome: "node_not_found" } as const;
          if (existing.deviceId) return { outcome: "already_paired" } as const;
          tx.update(nodes)
            .set({ ...grant, verifierHash: null, redeemedAt: null })
            .where(target)
            .run();
        } else {
          id = randomUUID();
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

  redeem(id: string, installToken: string, verifier: string, now = Date.now()) {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(nodes).where(eq(nodes.id, id)).get();
        if (!row || row.grantHash !== hash(installToken) || row.expiresAt === null)
          return { outcome: "invalid" } as const;
        const verifierHash = hash(verifier);
        if (row.redeemedAt !== null && row.verifierHash !== verifierHash)
          return { outcome: "claimed" } as const;
        const deadline = row.redeemedAt === null ? row.expiresAt : row.redeemedAt + grantLifetime;
        if (now >= deadline) return { outcome: "expired" } as const;
        const deviceId = row.deviceId ?? randomUUID();
        // Only the original token and verifier can reconstruct a lost reply. The database holds hashes.
        const token = `romedev_${createHmac("sha256", installToken)
          .update(`rome-lan-node:${id}:${deviceId}:${verifier}`)
          .digest("base64url")}`;
        if (row.redeemedAt === null) {
          tx.update(nodes)
            .set({ verifierHash, redeemedAt: now, deviceId, tokenHash: hash(token) })
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

  revoke(deviceId: string) {
    return (
      this.db
        .update(nodes)
        .set({
          deviceId: null,
          tokenHash: null,
          grantHash: null,
          expiresAt: null,
          verifierHash: null,
          redeemedAt: null,
        })
        .where(eq(nodes.deviceId, deviceId))
        .run().changes > 0
    );
  }
}
