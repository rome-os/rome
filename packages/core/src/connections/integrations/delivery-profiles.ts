import type { DeliveryProfile } from "../delivery/profile.js";

const defaults = {
  unsupportedMode: "blocks",
  operationSpacingMs: 1000,
  createSpacingMs: 1000,
  updateSpacingMs: 1000,
  conversationSpacingMs: 1000,
  burstCapacity: 1,
  coalesceMs: 500,
  maxPendingAgeMs: 3000,
  maxPendingBytes: 1024 * 1024,
  maxQueuedOperations: 256,
  formatting: "plain",
  formattingFallback: true,
} as const;

export function telegramDeliveryProfile(budgetKey: string): DeliveryProfile {
  return { ...defaults, mode: "edit", budgetKey, maxPartSize: 4000 };
}

export function discordDeliveryProfile(budgetKey: string): DeliveryProfile {
  return { ...defaults, mode: "edit", budgetKey, maxPartSize: 1900 };
}

export function wechatDeliveryProfile(budgetKey: string): DeliveryProfile {
  return {
    ...defaults,
    mode: "blocks",
    budgetKey,
    maxPartSize: 1800,
    createSpacingMs: 1500,
    conversationSpacingMs: 1500,
    coalesceMs: 1000,
  };
}

export function feishuDeliveryProfile(budgetKey: string): DeliveryProfile {
  return { ...defaults, mode: "edit", budgetKey, maxPartSize: 3500 };
}
