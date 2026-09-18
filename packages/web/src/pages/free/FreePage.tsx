import { useLocation } from "react-router-dom";
import { FreeGrid } from "./FreeGrid";

export default function FreePage() {
  const location = useLocation();
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";

  return (
    // Plain div: RomeShellLayout owns the `main` landmark. `hideSidebar` drops
    // the sidebar but keeps the layout, so this is nested either way.
    <div
      className={`flex min-h-0 flex-col overflow-hidden ${
        hideSidebar ? "h-dvh pt-safe" : "h-[var(--rome-mobile-content-height)] md:h-dvh"
      }`}
    >
      <FreeGrid />
    </div>
  );
}
