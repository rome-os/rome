import { writeFile, mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { persons } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { buildGatewayHtml } from "./gateway-html.js";
import type { PublicAccessConfig } from "./public-access-config.js";

const GATEWAY_DIR = "/etc/caddy/static";
const GATEWAY_HTML_PATH = `${GATEWAY_DIR}/gateway.html`;

export async function getInstanceName(db: DrizzleDb | null): Promise<string> {
  if (db) {
    try {
      const rows = await db
        .select()
        .from(persons)
        .where(eq(persons.bondLevel, "guardian"))
        .limit(1);
      if (rows.length > 0 && rows[0].displayName) {
        return rows[0].displayName;
      }
    } catch {
      // DB may not be available
    }
  }

  if (process.env.PANTHEON_SLUG) return process.env.PANTHEON_SLUG;

  return "This";
}

export async function generateGatewayPage(
  publicAccessConfig: PublicAccessConfig,
  instanceName: string,
): Promise<void> {
  const html = buildGatewayHtml({
    publicAccessConfig,
    instanceName,
    romeCloudSlug: process.env.PANTHEON_SLUG || null,
    romeCloudDomain: process.env.PANTHEON_DOMAIN || null,
    // Runtime-authoritative: the gateway regenerates at boot and
    // on publicAccess setting changes, and both paths read the live env var.
    gaMeasurementId: process.env.ROME_GA_MEASUREMENT_ID || null,
  });
  await mkdir(GATEWAY_DIR, { recursive: true });
  await writeFile(GATEWAY_HTML_PATH, html, "utf-8");
}
