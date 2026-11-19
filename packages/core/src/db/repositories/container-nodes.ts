import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { containerNodeInstallations as nodes } from "../schema.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class ContainerNodesRepository {
  constructor(private db: DrizzleDb) {}

  list(guardianId: string) {
    return this.db
      .select({ deviceId: nodes.deviceId, name: nodes.name })
      .from(nodes)
      .where(and(eq(nodes.guardianId, guardianId), isNotNull(nodes.tokenHash)))
      .all();
  }

  findByDeviceId(deviceId: string) {
    return this.db
      .select({ guardianId: nodes.guardianId })
      .from(nodes)
      .where(and(eq(nodes.deviceId, deviceId), isNotNull(nodes.tokenHash)))
      .get();
  }

  findByToken(token: string) {
    return this.db
      .select({ deviceId: nodes.deviceId, guardianId: nodes.guardianId })
      .from(nodes)
      .where(eq(nodes.tokenHash, hash(token)))
      .get();
  }

  create(guardianId: string, name: string) {
    const deviceId = randomUUID();
    const deviceToken = `romedev_${randomBytes(32).toString("base64url")}`;
    this.db
      .insert(nodes)
      .values({ id: deviceId, guardianId, name, deviceId, tokenHash: hash(deviceToken) })
      .run();
    return { deviceId, deviceToken };
  }

  rememberCloudDevice(guardianId: string, deviceId: string, name: string) {
    this.db
      .insert(nodes)
      .values({ id: deviceId, guardianId, name, deviceId })
      .onConflictDoNothing()
      .run();
  }

  cloudDeviceIds(): string[] {
    return this.db
      .select({ deviceId: nodes.deviceId })
      .from(nodes)
      .where(and(isNull(nodes.tokenHash), isNotNull(nodes.deviceId)))
      .all()
      .flatMap(({ deviceId }) => (deviceId ? [deviceId] : []));
  }

  forgetCloudDevice(deviceId: string) {
    this.db
      .delete(nodes)
      .where(and(eq(nodes.deviceId, deviceId), isNull(nodes.tokenHash)))
      .run();
  }

  rename(guardianId: string, deviceId: string, name: string) {
    return (
      this.db
        .update(nodes)
        .set({ name })
        .where(and(eq(nodes.guardianId, guardianId), eq(nodes.deviceId, deviceId)))
        .run().changes > 0
    );
  }

  remove(guardianId: string, deviceId: string) {
    return (
      this.db
        .delete(nodes)
        .where(and(eq(nodes.guardianId, guardianId), eq(nodes.deviceId, deviceId)))
        .run().changes > 0
    );
  }
}
