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
import "./globals.css";
import "./i18n";

// Emit the per-theme token blocks before first render. The index.html bootstrap
// has already replayed the active theme's cached CSS for a flash-free paint;
// this installs the full registry so theme switches resolve instantly.
injectThemeCss();

// No-op unless the boot-written /runtime-config.js carried a GA4 measurement
// ID — and never inside widget iframes (see lib/analytics.ts).
initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <GuardianTimestampProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </GuardianTimestampProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
