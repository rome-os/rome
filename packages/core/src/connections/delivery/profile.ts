import { z } from "zod";

export const deliveryProfileSchema = z
  .object({
    mode: z.enum(["edit", "blocks", "final"]),
    unsupportedMode: z.enum(["blocks", "final"]),
    budgetKey: z.string().min(1),
    operationSpacingMs: z.number().int().nonnegative(),
    createSpacingMs: z.number().int().nonnegative(),
    updateSpacingMs: z.number().int().nonnegative(),
    conversationSpacingMs: z.number().int().nonnegative(),
    burstCapacity: z.number().int().positive(),
    maxPartSize: z.number().int().min(2),
    coalesceMs: z.number().int().nonnegative(),
    maxPendingAgeMs: z.number().int().positive(),
    maxPendingBytes: z.number().int().positive(),
    maxQueuedOperations: z.number().int().positive(),
    formatting: z.enum(["plain", "native"]),
    formattingFallback: z.boolean(),
  })
  .strict();

export type DeliveryProfile = z.infer<typeof deliveryProfileSchema>;

export function resolveDeliveryProfile(
  defaults: DeliveryProfile,
  overrides: unknown,
  supportsUpdate: boolean,
  globalOverrides: unknown = {},
): DeliveryProfile {
  const profile = deliveryProfileSchema.parse({
    ...defaults,
    ...deliveryProfileSchema.partial().parse(globalOverrides),
    ...deliveryProfileSchema.partial().parse(overrides ?? {}),
  });
  if (profile.mode === "edit" && !supportsUpdate) profile.mode = profile.unsupportedMode;
  if (profile.formatting !== defaults.formatting) {
    throw new Error(`Delivery formatting "${profile.formatting}" is unsupported by this transport`);
  }
  if (profile.maxPartSize > defaults.maxPartSize) {
    throw new Error("Delivery part size exceeds the transport limit");
  }
  return profile;
}
