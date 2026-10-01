import { Navigate } from "react-router-dom";
import SettingsTabPage from "./SettingsTabPage";

/**
 * Bare /settings. From 768px up it is Appearance, the first section. On a
 * phone it is the list of sections, and each section opens as its own screen.
 */
export default function SettingsPage() {
  const phone =
    typeof window.matchMedia === "function" && window.matchMedia("(width < 48rem)").matches;
  return phone ? <SettingsTabPage /> : <Navigate to="/settings/appearance" replace />;
}
