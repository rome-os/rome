import { Navigate } from "react-router-dom";
import { useDesktop } from "@/hooks/use-desktop";
import SettingsTabPage from "./SettingsTabPage";

/**
 * Bare /settings. From 768px up it is Appearance, the first section. On a
 * phone it is the list of sections, and each section opens as its own screen.
 */
export default function SettingsPage() {
  return useDesktop() ? <Navigate to="/settings/appearance" replace /> : <SettingsTabPage />;
}
