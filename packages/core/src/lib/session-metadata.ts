import { z } from "zod";
import { isValidAppId } from "../apps/packaging/app-id.js";

export const sessionMetadataSchema = z.strictObject({
  isolated: z.boolean().optional(),
  purpose: z.string().trim().min(1).max(200).optional(),
  appId: z.string().max(100).refine(isValidAppId, "Invalid app id").optional(),
});

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

/** Legacy or malformed metadata has the same semantics as an unflagged session. */
export function parseSessionMetadata(raw: string | null | undefined): SessionMetadata {
  try {
    const value = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      ...(typeof value.isolated === "boolean" ? { isolated: value.isolated } : {}),
      ...(typeof value.purpose === "string" ? { purpose: value.purpose } : {}),
      ...(typeof value.appId === "string" ? { appId: value.appId } : {}),
    };
  } catch {
    return {};
  }
}
