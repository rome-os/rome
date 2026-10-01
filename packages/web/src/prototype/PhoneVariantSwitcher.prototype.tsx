// PROTOTYPE — the floating switcher for the phone redesign variants. Mounted
// from the mock entry only, so production builds never render it.
import { useEffect } from "react";
import {
  PHONE_VARIANTS,
  setPhoneVariant,
  usePickedPhoneVariant,
  type PhoneVariant,
} from "@/prototype/phone-variant.prototype";

function step(from: PhoneVariant, by: number): PhoneVariant {
  const index = PHONE_VARIANTS.findIndex((v) => v.key === from);
  return PHONE_VARIANTS[(index + by + PHONE_VARIANTS.length) % PHONE_VARIANTS.length].key;
}

export function PhoneVariantSwitcher() {
  const variant = usePickedPhoneVariant();
  const meta = PHONE_VARIANTS.find((v) => v.key === variant) ?? PHONE_VARIANTS[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "ArrowLeft") setPhoneVariant(step(variant, -1));
      if (event.key === "ArrowRight") setPhoneVariant(step(variant, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  // Fixed above any bottom bar, dashed and magenta so it never reads as part
  // of a variant.
  return (
    <div
      data-prototype-switcher
      style={{
        position: "fixed",
        left: "50%",
        top: "calc(var(--rome-safe-area-top, 0px) + 4px)",
        transform: "translateX(-50%)",
        zIndex: 2147483647,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 4px",
        border: "1px dashed #d0219c",
        borderRadius: 8,
        background: "rgba(255, 240, 250, 0.95)",
        color: "#7a0f5b",
        font: "600 11px/14px ui-monospace, monospace",
        maxWidth: "calc(100vw - 16px)",
        whiteSpace: "nowrap",
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => setPhoneVariant(step(variant, -1))}
        style={{ padding: "0 6px", font: "inherit" }}
      >
        ‹
      </button>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {meta.key.toUpperCase()} · {meta.name}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        onClick={() => setPhoneVariant(step(variant, 1))}
        style={{ padding: "0 6px", font: "inherit" }}
      >
        ›
      </button>
    </div>
  );
}
