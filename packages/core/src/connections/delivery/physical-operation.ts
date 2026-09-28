import { AsyncLocalStorage } from "node:async_hooks";
import type { DeliveryProfile } from "./profile.js";
import type { DeliveryScheduler } from "./scheduler.js";

export interface PhysicalDeliveryScope {
  profile: DeliveryProfile;
  scheduler: DeliveryScheduler;
  assertAuthorized(): void;
  signal?: AbortSignal;
}

export const physicalDeliveryScope = new AsyncLocalStorage<PhysicalDeliveryScope>();
export const scheduledPhysicalOperation = new AsyncLocalStorage<boolean>();

/** Adapters call this once per provider message mutation, including splits and attachments. */
export function physicalOperation<T>(
  conversation: string,
  kind: "create" | "update",
  operation: () => Promise<T>,
): Promise<T> {
  const scope = physicalDeliveryScope.getStore();
  if (!scope || scheduledPhysicalOperation.getStore()) return operation();
  return scope.scheduler.run(
    scope.profile,
    conversation,
    kind,
    scope.assertAuthorized,
    operation,
    scope.signal,
  );
}
