import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { GatedFeature } from "@rome/api-types/features";
import { isShown } from "@/lib/features";

interface FeatureGateProps {
  feature: GatedFeature;
  children: ReactNode;
  /** What shows in place of a hidden feature. Nothing, unless given. */
  fallback?: ReactNode;
}

/** Shows its children only while `feature` is shown. */
export function FeatureGate({ feature, children, fallback = null }: FeatureGateProps) {
  return isShown(feature) ? children : fallback;
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
