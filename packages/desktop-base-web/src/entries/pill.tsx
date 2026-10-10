import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PillPage } from "@/pages/PillPage";
import "@/globals.css";

// The window is transparent; the kit's body background would paint a rectangle
// behind the icon.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
document.body.style.overflow = "hidden";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <PillPage />
  </StrictMode>,
);
