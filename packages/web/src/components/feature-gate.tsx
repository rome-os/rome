import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { GatedFeature } from "@rome/api-types/features";
import { useFeatureState } from "@/hooks/use-features";

interface FeatureGateProps {
  feature: GatedFeature;
  children: ReactNode;
  /** What shows in place of a hidden feature. Nothing, unless given. */
  fallback?: ReactNode;
}

/** Shows its children only while `feature` is shown. Nothing renders until core
 *  has said, so a hidden feature never flashes into view. */
export function FeatureGate({ feature, children, fallback = null }: FeatureGateProps) {
  const state = useFeatureState(feature);
  if (state === "pending") return null;
  return state === "shown" ? children : fallback;
}

/** A route's element for a gated feature's page: a hidden feature's address
 *  opens the home page instead. */
export function FeatureRoute({ feature, children }: Omit<FeatureGateProps, "fallback">) {
  return (
    <FeatureGate feature={feature} fallback={<Navigate to="/" replace />}>
      {children}
    </FeatureGate>
  );
}
