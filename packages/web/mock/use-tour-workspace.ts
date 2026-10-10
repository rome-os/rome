import { useFreeCells as useDashboardWorkspace } from "../src/pages/free/use-free-cells.js";

export * from "../src/pages/free/use-free-cells.js";

export function useFreeCells() {
  const workspace = useDashboardWorkspace();
  const guided = new URLSearchParams(window.location.search).get("tour") === "build";
  return guided
    ? { ...workspace, toolView: { ...workspace.toolView, collapsed: true } }
    : workspace;
}
