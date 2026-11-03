import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The dashboard's theme module, so this local window renders with the same tokens as
// Settings → Devices. It has no other imports and runs no code at import time beyond a check.
import { buildThemeCss, DEFAULT_THEME_NAME, getThemeDefinitions } from "../../../web/src/lib/theme";
import { AuditPage } from "@/pages/AuditPage";
import "@/audit.css";

const style = document.createElement("style");
style.textContent = buildThemeCss(getThemeDefinitions());
document.head.append(style);
document.documentElement.dataset.theme = DEFAULT_THEME_NAME;

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <AuditPage />
  </StrictMode>,
);
