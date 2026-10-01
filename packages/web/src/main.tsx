import { DashboardScaleProvider } from "./hooks/use-preview-scale";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { GuardianTimestampProvider } from "./components/guardian-timestamp-provider";
import { ThemeProvider } from "./hooks/use-theme";
import { initAnalytics } from "./lib/analytics";
import { injectThemeCss } from "./lib/theme";
import { queryClient } from "./lib/query-client";
import { trackVisualViewport } from "./lib/visual-viewport";
import "./globals.css";
import "./i18n";

// Emit the per-theme token blocks before first render. The index.html bootstrap
// has already replayed the active theme's cached CSS for a flash-free paint;
// this installs the full registry so theme switches resolve instantly.
injectThemeCss();

// No-op unless the boot-written /runtime-config.js carried a GA4 measurement
// ID — and never inside widget iframes (see lib/analytics.ts).
initAnalytics();

// Sizes the shell to the screen area above an open keyboard (lib/visual-viewport.ts).
trackVisualViewport();

/**
 * Mounts the dashboard into #root. Exported so the regular entry
 * (src/entry.tsx) and the mock entry (mock/main.tsx) can control when the
 * app renders: mock mode starts the MSW worker first, then calls this, so the
 * app stays on the main chunk and keeps Fast Refresh instead of being isolated
 * behind a dynamic import (see rome-os/rome#383).
 */
export function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardScaleProvider>
            <ThemeProvider>
              <GuardianTimestampProvider>
                <App />
              </GuardianTimestampProvider>
            </ThemeProvider>
          </DashboardScaleProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
