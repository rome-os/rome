import type { ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { appFeature, type GatedFeature } from "@rome/api-types/features";
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

/** A route's element for a page about one app, read from the `:appId` route
 *  parameter: an app that is a hidden feature opens the home page instead. */
export function AppFeatureRoute({ children }: { children: ReactNode }) {
  const feature = appFeature(useParams().appId ?? "");
  return feature === undefined ? (
    children
  ) : (
    <FeatureRoute feature={feature}>{children}</FeatureRoute>
  );
}
