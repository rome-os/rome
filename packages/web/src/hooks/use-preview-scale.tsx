import { createContext, useContext, useState, type ReactNode } from "react";
import { UiScaleProvider, type UiScalePreference } from "@rome-os/ui/ui-scale";
import { useLocation } from "react-router-dom";

const PreviewScaleContext = createContext<{
  scale: UiScalePreference;
  setScale: (scale: UiScalePreference) => void;
} | null>(null);

export function PreviewScaleProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const [scale, setScale] = useState<UiScalePreference>("auto");
  return (
    <PreviewScaleContext.Provider value={{ scale, setScale }}>
      <UiScaleProvider scale={enabled ? scale : "auto"}>{children}</UiScaleProvider>
    </PreviewScaleContext.Provider>
  );
}

export function DashboardScaleProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <PreviewScaleProvider enabled={pathname === "/dev/gallery"}>{children}</PreviewScaleProvider>
  );
}

export function usePreviewScale() {
  const context = useContext(PreviewScaleContext);
  if (!context) throw new Error("usePreviewScale must be used inside PreviewScaleProvider");
  return context;
}
