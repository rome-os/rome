/**
 * Off-system padding predating the gate in `check-padding-scale.mjs`. A
 * quarantine list, not an exception list: nothing here is blessed. Adding an
 * entry takes an edit a reviewer sees, and a fixed value left listed fails the
 * test, so the list can't outlive the debt.
 *
 * The remaining baseline is concentrated in standalone stylesheets that do not
 * consume the kit's spacing bindings and need a migration decision rather than
 * a find-and-replace.
 */
export const BASELINE = {
  "packages/web/src/components/docx-preview-pane.tsx": ["padding: 1rem"],
  "packages/web/src/globals.css": ["padding-top: 2.5rem"],
  "packages/web/src/pages/dev/StyleGuidePage.tsx": [
    "padding: 12px",
    "padding: 16px",
    "padding: 4px 10px",
  ],
  "rome_apps/briefing/src/web/styles.css": [
    "padding-bottom: 8px",
    "padding: 16px",
    "padding: 1px 6px",
    "padding: 20px",
    "padding: 24px",
    "padding: 3px 8px",
    "padding: 4px 12px",
    "padding: 4px 2px",
    "padding: 6px 2px",
    "padding: 6px 8px",
    "padding: 8px 0 10px",
  ],
  "rome_apps/browser-automation/src/web/App.tsx": ['padding: "24px"', 'padding: "32px"'],
  "rome_apps/coding/src/web/styles.css": [
    "padding: 0.2rem 0.55rem",
    "padding: 0.45rem 0.85rem",
    "padding: 0.45rem 0.95rem",
    "padding: 0.75rem 0.9rem 0.85rem",
    "padding: 0.75rem 1rem",
    "padding: 0.7rem 1rem",
    "padding: 0.9rem",
    "padding: 1rem",
    "padding: clamp(1rem, 2vw, 1.75rem)",
  ],
  "rome_apps/inbox/src/web/App.tsx": ['padding: "24px"', 'padding: "32px"'],
  "rome_apps/recap/src/web/App.tsx": ["p-[18px]"],
  "rome_apps/system/src/web/App.tsx": ['padding: "24px"', 'padding: "32px"'],
  "rome_apps/workflow-studio/src/web/styles.css": [
    "padding: 10px 12px",
    "padding: 8px 12px",
    "padding: 8px 14px",
  ],
};

export const baselineKeys = new Set(
  Object.entries(BASELINE).flatMap(([file, values]) =>
    values.map((value) => `${file} :: ${value}`),
  ),
);
